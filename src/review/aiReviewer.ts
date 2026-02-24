import * as vscode from 'vscode';

export interface ReviewResult {
    rawMarkdown: string;
    model: string;
    prNumber: number;
    prTitle: string;
}

/**
 * GitHub Copilot (vscode.lm API) を使ってコードレビューを実行する
 */
export async function runAiReview(
    prompt: string,
    preferredModel: string,
    prNumber: number,
    prTitle: string,
    cancellationToken: vscode.CancellationToken,
    onChunk?: (chunk: string) => void
): Promise<ReviewResult> {
    // 利用可能なCopilotモデルを取得
    const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: preferredModel,
    });

    if (!models || models.length === 0) {
        // フォールバック: familyを指定せずに取得
        const fallbackModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (!fallbackModels || fallbackModels.length === 0) {
            throw new Error(
                'GitHub Copilotのモデルが利用できません。\n' +
                'GitHub Copilot拡張機能がインストール・有効化されているか確認してください。'
            );
        }
        return runWithModel(fallbackModels[0], prompt, prNumber, prTitle, cancellationToken, onChunk);
    }

    return runWithModel(models[0], prompt, prNumber, prTitle, cancellationToken, onChunk);
}

async function runWithModel(
    model: vscode.LanguageModelChat,
    prompt: string,
    prNumber: number,
    prTitle: string,
    cancellationToken: vscode.CancellationToken,
    onChunk?: (chunk: string) => void
): Promise<ReviewResult> {
    const messages = [
        vscode.LanguageModelChatMessage.User(prompt),
    ];

    const response = await model.sendRequest(messages, {}, cancellationToken);

    let fullText = '';
    for await (const chunk of response.text) {
        fullText += chunk;
        onChunk?.(chunk);
    }

    return {
        rawMarkdown: fullText,
        model: model.name,
        prNumber,
        prTitle,
    };
}
