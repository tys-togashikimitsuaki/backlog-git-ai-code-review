import * as diff from 'diff';

export interface Hunk {
    oldStart: number;
    newStart: number;
    lines: string[];
}

export interface FileDiff {
    oldPath: string;
    newPath: string;
    hunks: Hunk[];
    isNew: boolean;
    isDeleted: boolean;
    unifiedDiff: string;
}

/**
 * 2つのファイル内容からunified diffを生成する
 */
export function generateUnifiedDiff(
    oldContent: string,
    newContent: string,
    filename: string,
    oldRef: string = 'base',
    newRef: string = 'branch'
): string {
    return diff.createTwoFilesPatch(
        `a/${filename}`,
        `b/${filename}`,
        oldContent,
        newContent,
        oldRef,
        newRef,
        { context: 5 }
    );
}

/**
 * unified diff テキストをパースして FileDiff[] に変換する
 */
export function parseDiff(diffText: string): FileDiff[] {
    const results: FileDiff[] = [];
    const files = diff.parsePatch(diffText);

    for (const file of files) {
        const hunks: Hunk[] = file.hunks.map(h => ({
            oldStart: h.oldStart,
            newStart: h.newStart,
            lines: h.lines,
        }));

        results.push({
            oldPath: file.oldFileName ?? '',
            newPath: file.newFileName ?? '',
            hunks,
            isNew: file.oldFileName === '/dev/null',
            isDeleted: file.newFileName === '/dev/null',
            unifiedDiff: diffText,
        });
    }

    return results;
}

/**
 * diff から変更のあった行番号を取得する（新しいファイル側）
 */
export function getChangedLineNumbers(fileDiff: FileDiff): number[] {
    const lines: number[] = [];
    for (const hunk of fileDiff.hunks) {
        let lineNo = hunk.newStart;
        for (const line of hunk.lines) {
            if (line.startsWith('+')) {
                lines.push(lineNo);
                lineNo++;
            } else if (!line.startsWith('-')) {
                lineNo++;
            }
        }
    }
    return lines;
}
