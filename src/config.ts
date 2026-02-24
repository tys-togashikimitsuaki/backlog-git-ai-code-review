import * as vscode from 'vscode';

export interface BacklogConfig {
    spaceKey: string;
    apiKey: string;
    domain: string;
    copilotModel: string;
    definitionDepth: number;
    maxCharsPerFile: number;
}

export function getConfig(): BacklogConfig {
    const cfg = vscode.workspace.getConfiguration('backlogReview');
    return {
        spaceKey: cfg.get<string>('spaceKey', ''),
        apiKey: cfg.get<string>('apiKey', ''),
        domain: cfg.get<string>('domain', 'backlog.jp'),
        copilotModel: cfg.get<string>('copilotModel', 'gpt-4o'),
        definitionDepth: cfg.get<number>('definitionDepth', 2),
        maxCharsPerFile: cfg.get<number>('maxCharsPerFile', 20000),
    };
}

export async function promptForConfig(context: vscode.ExtensionContext): Promise<boolean> {
    const cfg = getConfig();

    if (!cfg.spaceKey) {
        const spaceKey = await vscode.window.showInputBox({
            title: 'Backlog スペースキーを入力',
            prompt: '例: mycompany (mycompany.backlog.jp の場合は "mycompany" のみ入力)',
            ignoreFocusOut: true,
        });
        if (!spaceKey) { return false; }
        await vscode.workspace.getConfiguration('backlogReview').update('spaceKey', spaceKey, true);
    }

    if (!cfg.apiKey) {
        const apiKey = await vscode.window.showInputBox({
            title: 'Backlog APIキーを入力',
            prompt: 'Backlog プロフィール > API > APIキーの発行 から取得',
            password: true,
            ignoreFocusOut: true,
        });
        if (!apiKey) { return false; }
        await vscode.workspace.getConfiguration('backlogReview').update('apiKey', apiKey, true);
    }

    return true;
}
