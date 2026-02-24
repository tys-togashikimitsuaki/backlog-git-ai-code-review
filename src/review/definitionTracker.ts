import * as vscode from 'vscode';
import * as path from 'path';

export interface DefinitionContext {
    symbolName: string;
    originFile: string;
    definitionFile: string;
    definitionContent: string;
    startLine: number;
    endLine: number;
}

/**
 * ファイル内の変更行にある識別子に対して vscode.executeDefinitionProvider を実行し、
 * 定義元のソースコードを収集する（再帰的に maxDepth まで辿る）
 */
export async function gatherDefinitionsForChangedLines(
    fileUri: vscode.Uri,
    changedLines: number[],
    maxDepth: number,
    maxCharsPerFile: number
): Promise<DefinitionContext[]> {
    const visited = new Set<string>();
    const results: DefinitionContext[] = [];

    await gatherRecursive(fileUri, changedLines, maxDepth, 0, visited, results, maxCharsPerFile);

    return results;
}

async function gatherRecursive(
    fileUri: vscode.Uri,
    targetLines: number[],
    maxDepth: number,
    currentDepth: number,
    visited: Set<string>,
    results: DefinitionContext[],
    maxCharsPerFile: number
): Promise<void> {
    if (currentDepth >= maxDepth) { return; }

    // ファイルを開いてドキュメントを取得
    let document: vscode.TextDocument;
    try {
        document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
        return;
    }

    // 既に訪問済みのファイルはスキップ
    if (visited.has(fileUri.toString())) { return; }
    visited.add(fileUri.toString());

    // 変更行ごとに各トークン位置でDefinitionProviderを実行
    for (const lineNo of targetLines) {
        const line = document.lineAt(Math.min(lineNo - 1, document.lineCount - 1));
        const lineText = line.text;

        // 行内の識別子を抽出（単語境界で分割）
        const identifiers = extractIdentifiers(lineText);

        for (const { name, col } of identifiers) {
            const position = new vscode.Position(Math.max(lineNo - 1, 0), col);
            const key = `${fileUri.toString()}:${lineNo}:${col}`;
            if (visited.has(key)) { continue; }
            visited.add(key);

            let locations: vscode.Location[] = [];
            try {
                const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
                    'vscode.executeDefinitionProvider',
                    fileUri,
                    position
                );
                if (!defs || defs.length === 0) { continue; }

                // Location | LocationLink を Location に正規化
                locations = defs.map(d => {
                    if ('targetUri' in d) {
                        return new vscode.Location(d.targetUri, d.targetRange);
                    }
                    return d as vscode.Location;
                });
            } catch {
                continue;
            }

            for (const loc of locations) {
                // 同じファイルの定義はスキップ（自己参照を避ける）
                if (loc.uri.toString() === fileUri.toString()) { continue; }

                const defKey = `${loc.uri.toString()}:${loc.range.start.line}`;
                if (visited.has(defKey)) { continue; }
                visited.add(defKey);

                try {
                    const defDoc = await vscode.workspace.openTextDocument(loc.uri);

                    // 定義が含まれるブロック（関数・クラス等）の範囲を特定
                    const { startLine, endLine, content } = extractDefinitionBlock(
                        defDoc,
                        loc.range.start.line,
                        maxCharsPerFile
                    );

                    results.push({
                        symbolName: name,
                        originFile: vscode.workspace.asRelativePath(fileUri),
                        definitionFile: vscode.workspace.asRelativePath(loc.uri),
                        definitionContent: content,
                        startLine,
                        endLine,
                    });

                    // 再帰的に定義元のファイルも追跡
                    const nextLines = [startLine, Math.floor((startLine + endLine) / 2)];
                    await gatherRecursive(
                        loc.uri,
                        nextLines,
                        maxDepth,
                        currentDepth + 1,
                        visited,
                        results,
                        maxCharsPerFile
                    );
                } catch {
                    continue;
                }
            }
        }
    }
}

/**
 * ドキュメント内の指定行から、定義ブロック（関数・クラス・メソッド）の範囲を抽出する
 */
function extractDefinitionBlock(
    doc: vscode.TextDocument,
    startLineIndex: number,
    maxChars: number
): { startLine: number; endLine: number; content: string } {
    const totalLines = doc.lineCount;

    // 上方向に関数/クラス宣言の先頭を探す
    let blockStart = startLineIndex;
    for (let i = startLineIndex; i >= Math.max(0, startLineIndex - 20); i--) {
        const lineText = doc.lineAt(i).text;
        if (/^\s*(export\s+)?(async\s+)?function|^\s*(export\s+)?class|^\s*(public|private|protected|static|async)\s+\w+\s*\(|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(lineText)) {
            blockStart = i;
            break;
        }
    }

    // ブレースのネストを追跡して関数ブロック末尾を探す
    let braceDepth = 0;
    let blockEnd = blockStart;
    let foundOpenBrace = false;
    let charCount = 0;

    for (let i = blockStart; i < totalLines; i++) {
        const lineText = doc.lineAt(i).text;
        charCount += lineText.length + 1;

        for (const ch of lineText) {
            if (ch === '{') { braceDepth++; foundOpenBrace = true; }
            if (ch === '}') { braceDepth--; }
        }

        if (foundOpenBrace && braceDepth === 0) {
            blockEnd = i;
            break;
        }

        if (charCount > maxChars) {
            blockEnd = i;
            break;
        }
    }

    const content = doc.getText(new vscode.Range(blockStart, 0, blockEnd + 1, 0));
    return {
        startLine: blockStart + 1,
        endLine: blockEnd + 1,
        content: content.slice(0, maxChars),
    };
}

/**
 * 行テキストから識別子とその列位置を抽出する
 */
function extractIdentifiers(lineText: string): { name: string; col: number }[] {
    const results: { name: string; col: number }[] = [];
    // コメント行はスキップ
    const stripped = lineText.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    const regex = /\b([A-Z][a-zA-Z0-9_]*|[a-z_][a-zA-Z0-9_]{2,})\s*[\.(]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(stripped)) !== null) {
        results.push({ name: match[1], col: match.index });
    }

    return results;
}

/**
 * DefinitionContext の配列を Markdown 形式に変換する
 */
export function formatDefinitionsAsMarkdown(definitions: DefinitionContext[]): string {
    if (definitions.length === 0) { return '（定義元ファイルの追跡結果なし）'; }

    const grouped = new Map<string, DefinitionContext[]>();
    for (const def of definitions) {
        const existing = grouped.get(def.definitionFile) ?? [];
        existing.push(def);
        grouped.set(def.definitionFile, existing);
    }

    const parts: string[] = [];
    for (const [file, defs] of grouped) {
        const symbols = [...new Set(defs.map(d => d.symbolName))].join(', ');
        // 重複ブロックを除去して最初の定義のみ採用
        const firstDef = defs[0];
        parts.push(
            `### 定義元: \`${file}\` (シンボル: \`${symbols}\`)\n` +
            `\`\`\`typescript\n${firstDef.definitionContent.trim()}\n\`\`\``
        );
    }

    return parts.join('\n\n');
}
