import { BacklogIssue, BacklogIssueComment, BacklogPullRequest } from '../backlog/backlogClient';
import { FileDiff } from '../git/diffAnalyzer';
import { DefinitionContext } from './definitionTracker';

export interface ReviewInput {
    pullRequest?: BacklogPullRequest;
    issue: BacklogIssue | null;
    issueComments: BacklogIssueComment[];
    fileDiffs: FileDiff[];
    fileContents: Map<string, string>;
    definitions: DefinitionContext[];
    maxCharsPerFile: number;
    baseBranch: string;
    compareBranch: string;
}

export function buildReviewPrompt(input: ReviewInput): string {
    const { pullRequest, issue, issueComments, fileDiffs, fileContents, definitions, maxCharsPerFile, baseBranch, compareBranch } = input;

    const issueSection = buildIssueSection(issue, issueComments, pullRequest, baseBranch, compareBranch);
    const fileSection = buildFileSection(fileDiffs, fileContents, maxCharsPerFile);
    const definitionSection = buildDefinitionSection(definitions);
    const diffSection = buildDiffSection(fileDiffs);

    return `# Role
あなたはBacklog Git運用に精通したシニアレビューアーです。厳格かつ建設的なフィードバックを日本語で行ってください。

---

# Context 1: 開発の目的 (Backlog)
${issueSection}

---

# Context 2: 変更されたファイルの全体像
${fileSection}

---

# Context 2-extra: 参照先の定義 (Definition Tracking)
\`vscode.executeDefinitionProvider\` で自動追跡した、変更行から参照されている関数・クラスの定義元です。

${definitionSection}

---

# Context 3: 具体的な変更差分 (Diff)
ベースブランチ: \`${baseBranch}\` ← 比較ブランチ: \`${compareBranch}\`

${diffSection}

---

# Mission
以下の観点でコードレビューを実施してください。

1. **仕様適合性**: Context 1の仕様・要件が、Context 3の変更で正しく実装されているか？
2. **既存ロジックとの整合性**: Context 2の既存コードと矛盾したり、デッドコードを生んでいないか？
3. **再利用性**: プロジェクト内の他の共通関数やクラスを使わずに、車輪の再発明をしていないか？
4. **冗長性とパフォーマンス**: 無駄なループや冗長な処理がないか？特にDBクエリにおいて、N+1問題など冗長な実行が発生していないか？
5. **DB実行計画の考慮**: クエリやORMによるDB処理の実行箇所において、クエリ実行計画（インデックスの使用、フルスキャン回避など）の観点で問題や改善点はないか？
6. **品質**: コードの可読性、命名、エラーハンドリング、型安全性の観点で問題はないか？

※ 重要: Backlogの仕様上、絵文字（Emoji）を含めると保存時にエラーになる場合があるため、出力には絵文字を一切含めないでください。

---

# Output Format
以下の形式で、かつ冒頭にレビュー対象の情報を分かりやすく記載してください。

## 【レビュー対象】
- **課題**: [XXXX-123] 課題名（提供されている場合のみ）
- **PR**: #123 PR名（提供されている場合のみ）
- **ブランチ**: \`base\` ← \`compare\`

## 【致命的】仕様漏れ・バグ・セキュリティリスク
（該当箇所のファイル名・行番号付きで指摘）

## 【警告】潜在的な問題・要確認事項

## 【推奨】リファクタリング案・改善提案

## 【称賛】良い実装箇所

## 総評
（全体的な品質評価と次のアクション）
`;
}

function buildIssueSection(
    issue: BacklogIssue | null,
    comments: BacklogIssueComment[],
    pr: BacklogPullRequest | undefined,
    baseBranch: string,
    compareBranch: string
): string {
    const parts: string[] = [];

    if (pr) {
        parts.push(`- **PR**: #${pr.number} ${pr.summary}`);
        parts.push(`- **マージ方向**: \`${pr.base}\` ← \`${pr.branch}\``);
        if (pr.description) {
            parts.push(`- **PR説明**:\n${pr.description.slice(0, 1000)}`);
        }
    } else {
        parts.push(`- **ブランチ比較**: \`${baseBranch}\` ← \`${compareBranch}\``);
    }

    if (issue) {
        parts.push(`\n- **課題**: [${issue.issueKey}] ${issue.summary}`);
        parts.push(`- **ステータス**: ${issue.status.name}`);
        if (issue.description) {
            const desc = issue.description.slice(0, 3000);
            parts.push(`- **課題詳細**:\n${desc}${issue.description.length > 3000 ? '\n...(省略)' : ''}`);
        }
    }

    if (comments.length > 0) {
        parts.push('\n- **課題コメント** (最新順):');
        for (const c of comments.slice(0, 10)) {
            const text = (c.content ?? '').slice(0, 500);
            if (!text.trim()) { continue; }
            parts.push(`  - [${c.createdUser.name} / ${c.created.slice(0, 10)}]: ${text}`);
        }
    }

    return parts.join('\n');
}

function buildFileSection(
    fileDiffs: FileDiff[],
    fileContents: Map<string, string>,
    maxCharsPerFile: number
): string {
    if (fileContents.size === 0) {
        return '（ファイル内容の取得に失敗しました。差分のあるファイルが検出されなかった可能性があります）';
    }

    const parts: string[] = [];
    for (const [filePath, content] of fileContents) {
        const truncated = content.length > maxCharsPerFile
            ? content.slice(0, maxCharsPerFile) + `\n\n... (${content.length - maxCharsPerFile}文字省略)`
            : content;
        const ext = filePath.split('.').pop() ?? '';
        parts.push(`### File: \`${filePath}\`\n\`\`\`${ext}\n${truncated}\n\`\`\``);
    }
    return parts.join('\n\n');
}

function buildDefinitionSection(definitions: DefinitionContext[]): string {
    if (definitions.length === 0) {
        return '（変更行から外部定義への参照が検出されませんでした）';
    }

    const grouped = new Map<string, DefinitionContext[]>();
    for (const def of definitions) {
        const existing = grouped.get(def.definitionFile) ?? [];
        existing.push(def);
        grouped.set(def.definitionFile, existing);
    }

    const parts: string[] = [];
    for (const [file, defs] of grouped) {
        const symbols = [...new Set(defs.map(d => `\`${d.symbolName}\``))].join(', ');
        const ext = file.split('.').pop() ?? '';
        parts.push(
            `### 定義元: \`${file}\` (シンボル: ${symbols})\n` +
            `\`\`\`${ext}\n${defs[0].definitionContent.trim()}\n\`\`\``
        );
    }
    return parts.join('\n\n');
}

function buildDiffSection(fileDiffs: FileDiff[]): string {
    if (fileDiffs.length === 0) {
        return '（差分なし、またはファイル変更が検出されませんでした）';
    }
    return fileDiffs
        .map(fd => `### ${fd.newPath || fd.oldPath}\n\`\`\`diff\n${fd.unifiedDiff}\n\`\`\``)
        .join('\n\n');
}
