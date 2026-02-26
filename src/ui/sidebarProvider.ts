import * as vscode from 'vscode';
import { BacklogClient, BacklogPullRequest, BacklogRepository, BacklogIssue, BacklogIssueComment } from '../backlog/backlogClient';
import { getConfig } from '../config';

// ツリーアイテムの種別
type TreeItemKind = 'project' | 'repository' | 'pullRequest' | 'message' | 'action' | 'selection';

export interface SelectionState {
    project?: { id: number; projectKey: string; name: string };
    repository?: BacklogRepository;
    issue?: { issue: BacklogIssue; comments: BacklogIssueComment[] };
    branches?: { baseBranch: string; compareBranch: string };
}

export class BacklogTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly kind: TreeItemKind,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly projectKey?: string,
        public readonly repoName?: string,
        public readonly prNumber?: number,
        public readonly prData?: BacklogPullRequest,
        public readonly commandId?: string
    ) {
        super(label, collapsibleState);

        if (commandId) {
            this.command = {
                command: commandId,
                title: label,
            };
        }

        switch (kind) {
            case 'action':
                if (commandId === 'backlogReview.startIssueReview') {
                    this.iconPath = new vscode.ThemeIcon('issues');
                } else if (commandId === 'backlogReview.startBranchReview') {
                    this.iconPath = new vscode.ThemeIcon('git-branch');
                } else if (commandId === 'backlogReview.clearSelection') {
                    this.iconPath = new vscode.ThemeIcon('clear-all');
                } else if (commandId === 'backlogReview.startReview') {
                    this.iconPath = new vscode.ThemeIcon('git-pull-request');
                } else if (commandId === 'backlogReview.selectModel') {
                    this.iconPath = new vscode.ThemeIcon('hubot');
                } else {
                    this.iconPath = new vscode.ThemeIcon('run-all');
                }
                this.contextValue = 'action';
                break;
            case 'selection':
                this.iconPath = new vscode.ThemeIcon('check');
                this.contextValue = 'selection';
                break;
            case 'project':
                this.iconPath = new vscode.ThemeIcon('folder');
                this.contextValue = 'project';
                break;
            case 'repository':
                this.iconPath = new vscode.ThemeIcon('repo');
                this.contextValue = 'repository';
                break;
            case 'pullRequest':
                this.iconPath = new vscode.ThemeIcon('git-pull-request');
                this.contextValue = 'pullRequest';
                this.tooltip = prData?.description ?? label;
                this.description = prData ? `${prData.base} ← ${prData.branch}` : '';
                break;
            case 'message':
                this.iconPath = new vscode.ThemeIcon('info');
                this.contextValue = 'message';
                break;
        }
    }
}

export class BacklogSidebarProvider implements vscode.TreeDataProvider<BacklogTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BacklogTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private client: BacklogClient | null = null;
    public state: SelectionState = {};

    refresh(): void {
        this.client = null;
        this._onDidChangeTreeData.fire();
    }

    updateSelection(newState: Partial<SelectionState>): void {
        this.state = { ...this.state, ...newState };
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BacklogTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BacklogTreeItem): Promise<BacklogTreeItem[]> {
        const cfg = getConfig();

        if (!cfg.spaceKey || !cfg.apiKey) {
            return [
                new BacklogTreeItem(
                    '⚙️ Backlogを設定してください',
                    'message',
                    vscode.TreeItemCollapsibleState.None
                ),
            ];
        }

        if (!this.client) {
            this.client = new BacklogClient(cfg.spaceKey, cfg.apiKey, cfg.domain);
        }

        try {
            if (!element) {
                // ルートレベル: 固定アクション + 現在の選択状況 + プロジェクト一覧
                const items: BacklogTreeItem[] = [
                    new BacklogTreeItem(
                        '選択をクリア',
                        'action',
                        vscode.TreeItemCollapsibleState.None,
                        undefined, undefined, undefined, undefined,
                        'backlogReview.clearSelection'
                    ),
                    new BacklogTreeItem(
                        `AIモデルを選択 (${cfg.copilotModel || '未選択'})`,
                        'action',
                        vscode.TreeItemCollapsibleState.None,
                        undefined, undefined, undefined, undefined,
                        'backlogReview.selectModel'
                    ),
                    new BacklogTreeItem(
                        '課題を選択',
                        'action',
                        vscode.TreeItemCollapsibleState.None,
                        undefined, undefined, undefined, undefined,
                        'backlogReview.startIssueReview'
                    ),
                    new BacklogTreeItem(
                        '--- ブランチを指定してレビュー ---',
                        'action',
                        vscode.TreeItemCollapsibleState.None,
                        undefined, undefined, undefined, undefined,
                        'backlogReview.startBranchReview'
                    ),
                ];

                // 選択状態の表示
                if (this.state.issue || this.state.branches) {
                    items.push(new BacklogTreeItem('--- 選択中 ---', 'message', vscode.TreeItemCollapsibleState.None));
                    if (this.state.issue) {
                        items.push(new BacklogTreeItem(
                            `課題: [${this.state.issue.issue.issueKey}] ${this.state.issue.issue.summary}`,
                            'selection',
                            vscode.TreeItemCollapsibleState.None
                        ));
                    }
                    if (this.state.branches) {
                        items.push(new BacklogTreeItem(
                            `ブランチ: ${this.state.branches.baseBranch} ← ${this.state.branches.compareBranch}`,
                            'selection',
                            vscode.TreeItemCollapsibleState.None
                        ));
                    }
                }

                items.push(new BacklogTreeItem('「プルリク」を指定してレビュー', 'message', vscode.TreeItemCollapsibleState.None));

                try {
                    const projects = await this.client.listProjects();
                    if (projects.length > 0) {
                        items.push(...projects.map(p =>
                            new BacklogTreeItem(
                                `${p.name} (${p.projectKey})`,
                                'project',
                                vscode.TreeItemCollapsibleState.Collapsed,
                                p.projectKey
                            )
                        ));
                    }
                } catch (err) {
                    items.push(new BacklogTreeItem(`⚠️ プロジェクト取得失敗: ${err}`, 'message', vscode.TreeItemCollapsibleState.None));
                }
                return items;
            }

            if (element.kind === 'project' && element.projectKey) {
                const repos = await this.client.listRepositories(element.projectKey);
                if (repos.length === 0) {
                    return [new BacklogTreeItem('Gitリポジトリなし', 'message', vscode.TreeItemCollapsibleState.None)];
                }
                return repos.map(r =>
                    new BacklogTreeItem(
                        r.name,
                        'repository',
                        vscode.TreeItemCollapsibleState.Collapsed,
                        element.projectKey,
                        r.name
                    )
                );
            }

            if (element.kind === 'repository' && element.projectKey && element.repoName) {
                const prs = await this.client.listPullRequests(element.projectKey, element.repoName, 1);
                if (prs.length === 0) {
                    return [new BacklogTreeItem('オープンなPRなし', 'message', vscode.TreeItemCollapsibleState.None)];
                }
                return prs.map(pr =>
                    new BacklogTreeItem(
                        `#${pr.number} ${pr.summary}`,
                        'pullRequest',
                        vscode.TreeItemCollapsibleState.None,
                        element.projectKey,
                        element.repoName,
                        pr.number,
                        pr
                    )
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return [new BacklogTreeItem(`エラー: ${msg}`, 'message', vscode.TreeItemCollapsibleState.None)];
        }

        return [];
    }
}
