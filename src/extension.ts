import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BacklogClient, BacklogIssue, BacklogPullRequest, BacklogRepository } from './backlog/backlogClient';
import { generateUnifiedDiff, parseDiff, getChangedLineNumbers } from './git/diffAnalyzer';
import { gatherDefinitionsForChangedLines } from './review/definitionTracker';
import { buildReviewPrompt, ReviewInput } from './review/promptBuilder';
import { runAiReview } from './review/aiReviewer';
import { ReviewPanel } from './ui/reviewPanel';
import { BacklogSidebarProvider, BacklogTreeItem } from './ui/sidebarProvider';
import { getConfig, promptForConfig } from './config';

const execFileAsync = promisify(execFile);
let cachedLocalRepoPath: string | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Backlog AI Reviewer: activating...');

    const sidebarProvider = new BacklogSidebarProvider();
    const treeView = vscode.window.createTreeView('backlogReviewTree', {
        treeDataProvider: sidebarProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.commands.registerCommand('backlogReview.configure', async () => {
            await promptForConfig(context);
            sidebarProvider.refresh();
            await vscode.commands.executeCommand('workbench.action.openSettings', 'backlogReview');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('backlogReview.refresh', () => {
            sidebarProvider.refresh();
        })
    );

    // ── コマンド: レビュー開始（マニュアル選択またはPR指定） ────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'backlogReview.startReview',
            async (treeItem?: BacklogTreeItem) => {
                const cfg = getConfig();
                if (!cfg.spaceKey || !cfg.apiKey) {
                    const ok = await promptForConfig(context);
                    if (!ok) { return; }
                }

                const client = new BacklogClient(cfg.spaceKey, cfg.apiKey, cfg.domain);

                // A. ツリーアイテム(PR)から起動された場合
                if (treeItem?.kind === 'pullRequest' && treeItem.projectKey && treeItem.repoName && treeItem.prNumber) {
                    let pr: BacklogPullRequest | undefined = treeItem.prData;
                    if (!pr) {
                        pr = await client.getPullRequest(treeItem.projectKey, treeItem.repoName, treeItem.prNumber);
                    }

                    if (!pr || !pr.base || !pr.branch) {
                        vscode.window.showErrorMessage('プルリクエストからブランチ情報を取得できませんでした。');
                        return;
                    }

                    // 1. 課題情報を取得（PRに紐付いている場合）
                    let issue: BacklogIssue | null = sidebarProvider.state.issue?.issue || null;
                    let issueComments = sidebarProvider.state.issue?.comments || [];

                    if (!issue && pr.issue?.issueKey) {
                        try {
                            issue = await client.getIssue(pr.issue.issueKey);
                            issueComments = await client.getIssueComments(pr.issue.issueKey);
                        } catch { /* ignore */ }
                    }

                    await executeReview(context, cfg, treeItem.projectKey, pr.repositoryId, pr, issue, issueComments, pr.base, pr.branch);
                    return;
                }

                // B. コマンドパレット等から直接呼び出された場合：現在の選択状態を使用
                if (sidebarProvider.state.branches && (sidebarProvider.state.project || sidebarProvider.state.repository)) {
                    const projectKey = sidebarProvider.state.project?.projectKey || sidebarProvider.state.repository?.httpUrl.split('/').slice(-3, -2)[0];
                    const repoId = sidebarProvider.state.repository?.id;

                    if (!projectKey || !repoId) {
                        vscode.window.showErrorMessage('プロジェクトまたはリポジトリが選択されていません。サイドバーから選択してください。');
                        return;
                    }

                    await executeReview(
                        context,
                        cfg,
                        projectKey,
                        repoId,
                        undefined,
                        sidebarProvider.state.issue?.issue || null,
                        sidebarProvider.state.issue?.comments || [],
                        sidebarProvider.state.branches.baseBranch,
                        sidebarProvider.state.branches.compareBranch
                    );
                } else {
                    vscode.window.showErrorMessage('レビュー対象のブランチが設定されていません。サイドバーの「ブランチを選択」から設定してください。');
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('backlogReview.startBranchReview', async () => {
            const cfg = getConfig();
            if (!cfg.spaceKey || !cfg.apiKey) {
                const ok = await promptForConfig(context);
                if (!ok) { return; }
            }
            await startBranchSelectionFlow(sidebarProvider, cfg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('backlogReview.startIssueReview', async () => {
            const cfg = getConfig();
            if (!cfg.spaceKey || !cfg.apiKey) {
                const ok = await promptForConfig(context);
                if (!ok) { return; }
            }
            await startIssueSelectionFlow(sidebarProvider, cfg);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('backlogReview.selectModel', async () => {
            await selectCopilotModel();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('backlogReview.postComment', async (args: { issueKey: string; content: string; panel: any }) => {
            const cfg = getConfig();
            const client = new BacklogClient(cfg.spaceKey, cfg.apiKey, cfg.domain);
            try {
                await client.addIssueComment(args.issueKey, args.content);
                if (args.panel && typeof args.panel.postResult === 'function') {
                    args.panel.postResult(true);
                } else {
                    vscode.window.showInformationMessage(`課題 ${args.issueKey} にコメントを投稿しました。`);
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (args.panel && typeof args.panel.postResult === 'function') {
                    args.panel.postResult(false, msg);
                } else {
                    vscode.window.showErrorMessage(`コメント投稿失敗: ${msg}`);
                }
            }
        })
    );
}

// ─── 課題選択フロー ──────────────────────────────────────
async function startIssueSelectionFlow(
    sidebarProvider: BacklogSidebarProvider,
    cfg: ReturnType<typeof getConfig>
) {
    const client = new BacklogClient(cfg.spaceKey, cfg.apiKey, cfg.domain);

    let projects: { id: number; projectKey: string; name: string }[];
    try {
        projects = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Backlog: プロジェクト一覧を取得中...' },
            () => client.listProjects()
        );
    } catch (e) {
        vscode.window.showErrorMessage(`プロジェクト取得失敗: ${e}`); return;
    }

    const projectPick = await vscode.window.showQuickPick(
        projects.map(p => ({ label: p.name, description: p.projectKey, project: p })),
        { title: 'プロジェクトを選択', ignoreFocusOut: true }
    );
    if (!projectPick) { return; }
    const project = projectPick.project;

    const result = await searchAndSelectIssue(client, project.id);
    if (!result) { return; }

    sidebarProvider.updateSelection({
        project,
        issue: result
    });

    vscode.window.showInformationMessage(`課題 「${result.issue.issueKey}」 を選択しました。`);
}

// ─── ブランチ選択フロー ──────────────────────────────────
async function startBranchSelectionFlow(
    sidebarProvider: BacklogSidebarProvider,
    cfg: ReturnType<typeof getConfig>
) {
    const client = new BacklogClient(cfg.spaceKey, cfg.apiKey, cfg.domain);

    let projects: { id: number; projectKey: string; name: string }[];
    try {
        projects = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Backlog: プロジェクト一覧を取得中...' },
            () => client.listProjects()
        );
    } catch (e) {
        vscode.window.showErrorMessage(`プロジェクト取得失敗: ${e}`); return;
    }

    const projectPick = await vscode.window.showQuickPick(
        projects.map(p => ({ label: p.name, description: p.projectKey, project: p })),
        { title: 'プロジェクトを選択', ignoreFocusOut: true }
    );
    if (!projectPick) { return; }
    const project = projectPick.project;

    let repos: BacklogRepository[];
    try {
        repos = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Backlog: リポジトリ一覧を取得中...' },
            () => client.listRepositories(project.projectKey)
        );
    } catch (e) {
        vscode.window.showErrorMessage(`リポジトリ取得失敗: ${e}`); return;
    }

    const repoPick = await vscode.window.showQuickPick(
        repos.map(r => ({ label: r.name, description: r.description, repo: r })),
        { title: 'リポジトリを選択', ignoreFocusOut: true }
    );
    if (!repoPick) { return; }
    const repo = repoPick.repo;

    const branchPair = await selectBranchPair(client, project.id, repo.id);
    if (!branchPair) { return; }

    sidebarProvider.updateSelection({
        project,
        repository: repo,
        branches: branchPair
    });

    vscode.window.showInformationMessage(`ブランチ 「${branchPair.baseBranch} ← ${branchPair.compareBranch}」 を選択しました。`);
}

async function promptBranchPairManually(): Promise<{ baseBranch: string; compareBranch: string } | null> {
    const baseBranch = await vscode.window.showInputBox({
        title: 'マージ先（ベース）ブランチを入力',
        prompt: '例: main',
        ignoreFocusOut: true,
    });
    if (!baseBranch) { return null; }

    const compareBranch = await vscode.window.showInputBox({
        title: '比較（フィーチャー）ブランチを入力',
        prompt: '例: feature/xxx',
        ignoreFocusOut: true,
        validateInput: (v) => (v === baseBranch ? 'ベースブランチと同じ名前は指定できません' : null),
    });
    if (!compareBranch) { return null; }

    return { baseBranch, compareBranch };
}

async function selectBranchPair(
    client: BacklogClient,
    projectIdOrKey: number | string,
    repoIdOrName: number | string
): Promise<{ baseBranch: string; compareBranch: string } | null> {
    try {
        const branches = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Backlog: ブランチ一覧を取得中...' },
            () => client.listBranches(projectIdOrKey, repoIdOrName)
        );

        if (!branches || branches.length === 0) {
            vscode.window.showWarningMessage('ブランチ一覧が空のため、手入力で指定してください。');
            return promptBranchPairManually();
        }

        const branchItems = branches.map(b => ({
            label: b.name,
            description: b.commit.message.slice(0, 60),
        }));

        const basePick = await vscode.window.showQuickPick(branchItems, {
            title: 'マージ先（ベース）ブランチを選択',
            ignoreFocusOut: true,
        });
        if (!basePick) { return null; }

        const comparePick = await vscode.window.showQuickPick(
            branchItems.filter(b => b.label !== basePick.label),
            { title: '比較（フィーチャー）ブランチを選択', ignoreFocusOut: true }
        );
        if (!comparePick) { return null; }

        return { baseBranch: basePick.label, compareBranch: comparePick.label };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showWarningMessage(`ブランチ一覧の取得に失敗したため、手入力に切り替えます: ${msg}`);
        return promptBranchPairManually();
    }
}

// ─── 課題検索ヘルパー ────────────────────────────────────────────
async function searchAndSelectIssue(
    client: BacklogClient,
    projectId: number
): Promise<{ issue: BacklogIssue; comments: import('./backlog/backlogClient').BacklogIssueComment[] } | null> {
    const keyword = await vscode.window.showInputBox({
        title: '課題を検索',
        prompt: 'キーワードまたは課題キー (例: PROJ-123 または "決済処理")',
        ignoreFocusOut: true,
    });
    const normalizedKeyword = (keyword ?? '').replace(/\u3000/g, ' ').trim();
    if (!normalizedKeyword) { return null; }

    let issues: BacklogIssue[];
    try {
        if (/^[A-Z0-9]+-\d+$/i.test(normalizedKeyword)) {
            issues = [await client.getIssue(normalizedKeyword)];
        } else {
            issues = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `"${normalizedKeyword}" を検索中...` },
                () => client.searchIssues(projectId, normalizedKeyword)
            );

            // Backlog検索がまれに初回0件になるケースへの軽いリトライ
            if (issues.length === 0) {
                await new Promise(resolve => setTimeout(resolve, 250));
                issues = await client.searchIssues(projectId, normalizedKeyword);
            }
        }
    } catch (e) {
        vscode.window.showErrorMessage(`課題検索失敗: ${e}`);
        return null;
    }

    if (issues.length === 0) {
        vscode.window.showInformationMessage(`"${normalizedKeyword}" に一致する課題が見つかりません`);
        return null;
    }

    // Backlogのkeyword検索結果には関連度の低い課題が混ざることがあるため、
    // issueKey / summary / description への部分一致で厳しめに絞り込む
    const tokens = normalizedKeyword
        .toLowerCase()
        .split(/\s+/)
        .map(t => t.trim())
        .filter(Boolean);

    if (tokens.length > 0 && !/^[A-Z0-9]+-\d+$/i.test(normalizedKeyword)) {
        const filtered = issues
            .filter(i => {
                const key = i.issueKey.toLowerCase();
                const summary = (i.summary ?? '').toLowerCase();
                const description = (i.description ?? '').toLowerCase();
                return tokens.every(t => key.includes(t) || summary.includes(t) || description.includes(t));
            })
            .sort((a, b) => {
                const aScore = scoreIssue(a, tokens);
                const bScore = scoreIssue(b, tokens);
                return bScore - aScore;
            });

        if (filtered.length > 0) {
            issues = filtered;
        } else {
            vscode.window.showInformationMessage(`"${normalizedKeyword}" に一致する課題が見つかりません`);
            return null;
        }
    }

    let selectedIssue: BacklogIssue;
    if (issues.length === 1) {
        selectedIssue = issues[0];
    } else {
        const pick = await vscode.window.showQuickPick(
            issues.map(i => ({
                label: `[${i.issueKey}] ${i.summary}`,
                description: i.status.name,
                issue: i,
            })),
            { title: '課題を選択', ignoreFocusOut: true }
        );
        if (!pick) { return null; }
        selectedIssue = pick.issue;
    }

    let comments: import('./backlog/backlogClient').BacklogIssueComment[] = [];
    try {
        comments = await client.getIssueComments(selectedIssue.issueKey);
    } catch {
        // Ignore
    }

    return { issue: selectedIssue, comments };
}

function scoreIssue(issue: BacklogIssue, tokens: string[]): number {
    const key = issue.issueKey.toLowerCase();
    const summary = (issue.summary ?? '').toLowerCase();
    const description = (issue.description ?? '').toLowerCase();

    let score = 0;
    for (const t of tokens) {
        if (key.includes(t)) { score += 6; }
        if (summary.includes(t)) { score += 4; }
        if (description.includes(t)) { score += 1; }
    }

    return score;
}

// ─── 動的Copilotモデル選択 ──────────────────────────────────────
async function selectCopilotModel(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models || models.length === 0) {
        vscode.window.showErrorMessage('GitHub Copilotのモデルが取得できません。Copilot拡張機能が有効か確認してください。');
        return;
    }

    const pick = await vscode.window.showQuickPick(
        models.map(m => ({
            label: m.name,
            description: `family: ${m.family} | max: ${m.maxInputTokens.toLocaleString()} tokens`,
            id: m.family,
        })),
        { title: 'GitHub Copilot モデルを選択', ignoreFocusOut: true }
    );

    if (!pick) { return; }
    await vscode.workspace.getConfiguration('backlogReview').update('copilotModel', pick.id, true);
    vscode.window.showInformationMessage(`モデルを "${pick.label}" に設定しました`);
}

// ─── レビュー実行コア ────────────────────────────────────────────
async function executeReview(
    context: vscode.ExtensionContext,
    cfg: ReturnType<typeof getConfig>,
    projectKey: string,
    repoId: number,
    pr: BacklogPullRequest | undefined,
    issue: BacklogIssue | null,
    issueComments: import('./backlog/backlogClient').BacklogIssueComment[],
    baseBranch: string,
    compareBranch: string
) {
    const cancellationSource = new vscode.CancellationTokenSource();
    const panel = ReviewPanel.createOrShow(context.extensionUri);
    const title = pr ? pr.summary : (issue ? `[${issue.issueKey}] ${issue.summary}` : `${compareBranch} → ${baseBranch}`);
    const prNumber = pr?.number ?? 0;
    panel.showLoading(prNumber, title, projectKey, String(repoId));

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Backlog AI Reviewer', cancellable: true },
        async (progress, token) => {
            token.onCancellationRequested(() => cancellationSource.cancel());
            try {
                const client = new BacklogClient(cfg.spaceKey, cfg.apiKey, cfg.domain);

                progress.report({ message: `差分を生成中: ${baseBranch} ← ${compareBranch}` });
                const { fileDiffs, fileContents } = await generateFileDiffsFromBranches(
                    client, projectKey, repoId, baseBranch, compareBranch, cfg.maxCharsPerFile, progress
                );

                if (fileDiffs.length === 0) {
                    panel.showError(
                        `ブランチ間の差分が検出されませんでした。\n\nbase: ${baseBranch}\ncompare: ${compareBranch}\n\n` +
                        'ブランチ名が正しいか、対象ファイルにソースコードが含まれているか確認してください。'
                    );
                    return;
                }

                progress.report({ message: '定義元を追跡中...' });
                const allDefinitions = await runDefinitionTracking(fileDiffs, fileContents, cfg);

                progress.report({ message: 'プロンプトを組み立て中...' });
                const reviewInput: ReviewInput = {
                    pullRequest: pr,
                    issue,
                    issueComments,
                    fileDiffs,
                    fileContents,
                    definitions: allDefinitions,
                    maxCharsPerFile: cfg.maxCharsPerFile,
                    baseBranch,
                    compareBranch,
                };
                const prompt = buildReviewPrompt(reviewInput);

                progress.report({ message: 'GitHub Copilotがレビュー中...' });
                const result = await runAiReview(
                    prompt,
                    cfg.copilotModel,
                    prNumber,
                    title,
                    cancellationSource.token,
                    (chunk) => panel.appendChunk(chunk)
                );

                panel.showResult(prNumber, title, projectKey, String(repoId), cfg.spaceKey, result.rawMarkdown, result.model, issue?.issueKey);

            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                panel.showError(msg);
                vscode.window.showErrorMessage(`Backlog AI Reviewer: ${msg}`);
            } finally {
                cancellationSource.dispose();
            }
        }
    );
}

async function generateFileDiffsFromBranches(
    client: BacklogClient,
    projectKey: string,
    repoId: number,
    baseBranch: string,
    compareBranch: string,
    maxCharsPerFile: number,
    progress: vscode.Progress<{ message?: string }>
): Promise<{ fileDiffs: import('./git/diffAnalyzer').FileDiff[]; fileContents: Map<string, string> }> {
    const errors: string[] = [];
    const baseRefs = buildRefCandidates(baseBranch);
    const compareRefs = buildRefCandidates(compareBranch);

    progress.report({ message: `${compareBranch} のファイル一覧を取得中...` });
    const allFiles = await collectAllFilesWithFallback(client, projectKey, repoId, compareRefs, '', 0, errors);

    const fileDiffs: import('./git/diffAnalyzer').FileDiff[] = [];
    const fileContents = new Map<string, string>();

    // 最大30ファイル。それ以上の場合はスキップして通知
    const targetFiles = allFiles.slice(0, 30);

    for (const filePath of targetFiles) {
        try {
            const [baseResult, compareResult] = await Promise.all([
                getFileContentWithFallback(client, projectKey, repoId, baseRefs, filePath),
                getFileContentWithFallback(client, projectKey, repoId, compareRefs, filePath),
            ]);

            if (!baseResult.ok && !compareResult.ok) {
                errors.push(`file: ${filePath} | base: ${baseResult.error ?? 'unknown'} | compare: ${compareResult.error ?? 'unknown'}`);
                continue;
            }

            const baseContent = baseResult.content;
            const branchContent = compareResult.content;

            if (baseContent === branchContent) { continue; }

            const diffText = generateUnifiedDiff(baseContent, branchContent, filePath, baseBranch, compareBranch);
            const parsed = parseDiff(diffText);
            for (const fd of parsed) {
                fileDiffs.push({ ...fd, unifiedDiff: diffText });
            }
            fileContents.set(filePath, branchContent);
        } catch (e) {
            errors.push(`file: ${filePath} | unexpected: ${e instanceof Error ? e.message : String(e)}`);
            // Skip individual file fail
        }
    }

    if (fileDiffs.length === 0 && errors.length > 0) {
        const contentsUnsupported = errors.some(e =>
            e.includes('Undefined resource') && e.includes('/contents')
        );

        if (contentsUnsupported) {
            const local = await pickLocalRepositoryPath();
            if (local) {
                return generateFileDiffsFromLocalGit(local, baseBranch, compareBranch, progress);
            }
        }

        throw new Error(
            '差分生成中にBacklog APIエラーが発生しました。' +
            `\nbase: ${baseBranch}\ncompare: ${compareBranch}` +
            `\n\n例: ${errors[0]}`
        );
    }

    return { fileDiffs, fileContents };
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|java|py|go|rb|php|cs|cpp|c|h|swift|kt|rs|vue|svelte|scala|dart)$/;

async function collectAllFiles(
    client: BacklogClient,
    projectKey: string,
    repoId: number,
    ref: string,
    dirPath: string,
    depth: number
): Promise<string[]> {
    if (depth > 5) { return []; }
    let entries;
    try {
        entries = await client.listFiles(projectKey, repoId, ref, dirPath);
    } catch {
        return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        if (entry.type === 'tree') {
            const sub = await collectAllFiles(client, projectKey, repoId, ref, fullPath, depth + 1);
            files.push(...sub);
        } else if (entry.type === 'blob' && SOURCE_EXT.test(entry.name)) {
            files.push(fullPath);
        }
    }
    return files;
}

async function pickLocalRepositoryPath(): Promise<string | null> {
    const picks: { label: string; description?: string; value: 'cached' | 'select' | 'cancel' }[] = [];

    if (cachedLocalRepoPath) {
        picks.push({ label: '前回のローカルリポジトリを使う', description: cachedLocalRepoPath, value: 'cached' });
    }

    picks.push({ label: 'ローカルGitリポジトリを選択...', value: 'select' });
    picks.push({ label: 'キャンセル', value: 'cancel' });

    const pick = await vscode.window.showQuickPick(picks, {
        title: 'Backlog APIでファイル取得できないため、ローカルGitから差分を取得します',
        ignoreFocusOut: true,
    });

    if (!pick || pick.value === 'cancel') {
        return null;
    }

    if (pick.value === 'cached' && cachedLocalRepoPath) {
        return cachedLocalRepoPath;
    }

    const folder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'このフォルダを使用',
    });

    if (!folder || folder.length === 0) {
        return null;
    }

    const selected = folder[0].fsPath;
    cachedLocalRepoPath = selected;
    return selected;
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd: repoPath,
            maxBuffer: 20 * 1024 * 1024,
        });
        return stdout;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`git ${args.join(' ')} failed: ${msg}`);
    }
}

function buildLocalGitRefCandidates(ref: string): string[] {
    const r = ref.trim();
    if (!r) { return []; }

    const cands = new Set<string>([r]);

    if (r.startsWith('refs/heads/')) {
        const short = r.replace(/^refs\/heads\//, '');
        cands.add(short);
        cands.add(`origin/${short}`);
        cands.add(`refs/remotes/origin/${short}`);
    } else if (r.startsWith('refs/remotes/origin/')) {
        const short = r.replace(/^refs\/remotes\/origin\//, '');
        cands.add(short);
        cands.add(`origin/${short}`);
        cands.add(`refs/heads/${short}`);
    } else if (r.startsWith('origin/')) {
        const short = r.replace(/^origin\//, '');
        cands.add(short);
        cands.add(`refs/heads/${short}`);
        cands.add(`refs/remotes/origin/${short}`);
    } else {
        cands.add(`refs/heads/${r}`);
        cands.add(`origin/${r}`);
        cands.add(`refs/remotes/origin/${r}`);
    }

    return [...cands];
}

async function resolveLocalGitRef(repoPath: string, inputRef: string): Promise<string> {
    const candidates = buildLocalGitRefCandidates(inputRef);
    for (const c of candidates) {
        try {
            const resolved = await runGit(repoPath, ['rev-parse', '--verify', `${c}^{commit}`]);
            return resolved.trim();
        } catch {
            // try next candidate
        }
    }

    const branches = await runGit(repoPath, ['branch', '--all', '--list']).catch(() => '');
    throw new Error(
        `ブランチ参照を解決できませんでした: ${inputRef}` +
        `\n候補: ${candidates.join(', ')}` +
        (branches ? `\n\n利用可能なブランチ:\n${branches}` : '')
    );
}

async function generateFileDiffsFromLocalGit(
    repoPath: string,
    baseBranch: string,
    compareBranch: string,
    progress: vscode.Progress<{ message?: string }>
): Promise<{ fileDiffs: import('./git/diffAnalyzer').FileDiff[]; fileContents: Map<string, string> }> {
    progress.report({ message: `ローカルGit差分を取得中: ${baseBranch}..${compareBranch}` });

    await runGit(repoPath, ['rev-parse', '--git-dir']);

    const baseRef = await resolveLocalGitRef(repoPath, baseBranch);
    const compareRef = await resolveLocalGitRef(repoPath, compareBranch);

    const changed = await runGit(repoPath, ['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}..${compareRef}`]);
    const files = changed
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .filter(f => SOURCE_EXT.test(f))
        .slice(0, 30);

    const fileDiffs: import('./git/diffAnalyzer').FileDiff[] = [];
    const fileContents = new Map<string, string>();

    for (const filePath of files) {
        const [baseContent, branchContent] = await Promise.all([
            runGit(repoPath, ['show', `${baseRef}:${filePath}`]).catch(() => ''),
            runGit(repoPath, ['show', `${compareRef}:${filePath}`]).catch(() => ''),
        ]);

        if (baseContent === branchContent) { continue; }

        const diffText = generateUnifiedDiff(baseContent, branchContent, filePath, baseBranch, compareBranch);
        const parsed = parseDiff(diffText);
        for (const fd of parsed) {
            fileDiffs.push({ ...fd, unifiedDiff: diffText });
        }
        fileContents.set(filePath, branchContent);
    }

    if (fileDiffs.length === 0) {
        throw new Error(
            `ローカルGitでも差分が見つかりませんでした。\nrepo: ${repoPath}\nbase: ${baseBranch}\ncompare: ${compareBranch}`
        );
    }

    return { fileDiffs, fileContents };
}

function buildRefCandidates(branch: string): string[] {
    const b = branch.trim();
    if (!b) { return []; }
    if (b.startsWith('refs/heads/')) {
        return [b, b.replace(/^refs\/heads\//, '')];
    }
    return [b, `refs/heads/${b}`];
}

async function collectAllFilesWithFallback(
    client: BacklogClient,
    projectKey: string,
    repoId: number,
    refs: string[],
    dirPath: string,
    depth: number,
    errors: string[]
): Promise<string[]> {
    let lastError: string | null = null;
    for (const ref of refs) {
        const files = await collectAllFiles(client, projectKey, repoId, ref, dirPath, depth);
        if (files.length > 0) { return files; }

        // collectAllFilesは失敗を握りつぶすため、ルートで明示チェックしてエラーを拾う
        if (dirPath === '' && depth === 0) {
            try {
                await client.listFiles(projectKey, repoId, ref, dirPath);
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
            }
        }
    }

    if (lastError) {
        errors.push(`listFiles failed for refs=[${refs.join(', ')}]: ${lastError}`);
    }
    return [];
}

async function getFileContentWithFallback(
    client: BacklogClient,
    projectKey: string,
    repoId: number,
    refs: string[],
    filePath: string
): Promise<{ ok: boolean; content: string; error?: string }> {
    let lastError: string | undefined;
    for (const ref of refs) {
        try {
            const content = await client.getFileContent(projectKey, repoId, ref, filePath);
            return { ok: true, content };
        } catch (e) {
            lastError = `${ref}: ${e instanceof Error ? e.message : String(e)}`;
        }
    }
    return { ok: false, content: '', error: lastError };
}

async function runDefinitionTracking(
    fileDiffs: import('./git/diffAnalyzer').FileDiff[],
    fileContents: Map<string, string>,
    cfg: ReturnType<typeof getConfig>
): Promise<import('./review/definitionTracker').DefinitionContext[]> {
    const allDefinitions: import('./review/definitionTracker').DefinitionContext[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || cfg.definitionDepth === 0) { return allDefinitions; }

    for (const fd of fileDiffs) {
        const filePath = fd.newPath.replace(/^b\//, '');
        if (!fileContents.has(filePath)) { continue; }

        const localUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
        try {
            await vscode.workspace.fs.stat(localUri);
            const changedLines = getChangedLineNumbers(fd);
            const defs = await gatherDefinitionsForChangedLines(
                localUri, changedLines, cfg.definitionDepth, cfg.maxCharsPerFile
            );
            allDefinitions.push(...defs);
        } catch {
            // Skip
        }
    }
    return allDefinitions;
}

export function deactivate() { }
