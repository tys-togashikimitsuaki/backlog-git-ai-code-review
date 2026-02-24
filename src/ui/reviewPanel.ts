import * as vscode from 'vscode';
import * as path from 'path';

export class ReviewPanel {
  private static instance: ReviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.onDidDispose(() => {
      ReviewPanel.instance = undefined;
    });
  }

  static createOrShow(extensionUri: vscode.Uri): ReviewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ReviewPanel.instance) {
      ReviewPanel.instance.panel.reveal(column);
      return ReviewPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      'backlogAiReview',
      'Backlog AI Review',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ReviewPanel.instance = new ReviewPanel(panel, extensionUri);
    return ReviewPanel.instance;
  }

  showLoading(prNumber: number, prTitle: string, projectKey: string, repoName: string) {
    this.panel.title = `AI Review: #${prNumber}`;
    this.panel.webview.html = this.getLoadingHtml(prNumber, prTitle, projectKey, repoName);
  }

  appendChunk(chunk: string) {
    this.panel.webview.postMessage({ type: 'chunk', content: chunk });
  }

  showResult(
    prNumber: number,
    prTitle: string,
    projectKey: string,
    repoName: string,
    spaceKey: string,
    markdown: string,
    modelName: string,
    issueKey?: string
  ) {
    this.panel.title = `AI Review: #${prNumber}`;
    this.panel.webview.html = this.getResultHtml(
      prNumber, prTitle, projectKey, repoName, spaceKey, markdown, modelName, issueKey
    );

    this.panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'postComment') {
        await vscode.commands.executeCommand('backlogReview.postComment', {
          issueKey: msg.issueKey,
          content: msg.content,
          panel: this
        });
      }
    });
  }

  private postResult(success: boolean, error?: string) {
    this.panel.webview.postMessage({ type: 'postResult', success, error });
  }

  showError(message: string) {
    this.panel.webview.html = this.getErrorHtml(message);
  }

  private getLoadingHtml(
    prNumber: number,
    prTitle: string,
    projectKey: string,
    repoName: string
  ): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Review Loading</title>
  <style>
    ${this.getBaseStyles()}
    .loading-container { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 60vh; gap: 24px; }
    .spinner { width: 56px; height: 56px; border: 4px solid var(--vscode-editor-background); border-top: 4px solid var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .review-output { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); line-height: 1.7; padding: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="pr-badge">PR #${prNumber}</div>
    <h1>${escapeHtml(prTitle)}</h1>
    <div class="meta">${projectKey} / ${repoName}</div>
  </div>
  <div class="loading-container" id="loader">
    <div class="spinner"></div>
    <p>GitHub Copilot がレビューを生成中です...</p>
  </div>
  <div class="section" id="stream-output" style="display:none;">
    <div class="review-output" id="stream-content"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const loader = document.getElementById('loader');
    const streamOutput = document.getElementById('stream-output');
    const streamContent = document.getElementById('stream-content');
    let hasContent = false;

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'chunk') {
        if (!hasContent) {
          loader.style.display = 'none';
          streamOutput.style.display = 'block';
          hasContent = true;
        }
        streamContent.textContent += msg.content;
        window.scrollTo(0, document.body.scrollHeight);
      }
    });
  </script>
</body>
</html>`;
  }

  private getResultHtml(
    prNumber: number,
    prTitle: string,
    projectKey: string,
    repoName: string,
    spaceKey: string,
    markdown: string,
    modelName: string,
    issueKey?: string
  ): string {
    const prUrl = `https://${spaceKey}.backlog.com/git/${projectKey}/${repoName}/pullRequests/${prNumber}`;
    const renderedMarkdown = markdownToHtml(markdown);

    const postButton = issueKey ? `
        <div class="action-bar">
          <button id="post-comment-btn" class="btn primary">
            <span class="codicon codicon-comment"></span> Backlog課題 (${issueKey}) にコメントとして投稿
          </button>
          <div id="post-status" class="status-msg"></div>
        </div>
        ` : '';

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Review #${prNumber}</title>
  <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.32/dist/codicon.css" rel="stylesheet" />
  <style>
    ${this.getBaseStyles()}
    ${this.getReviewStyles()}
    .action-bar { padding: 16px 32px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); position: sticky; bottom: 0; display: flex; align-items: center; gap: 16px; }
    .btn { padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .status-msg { font-size: 12px; }
    .status-msg.success { color: var(--praise); }
    .status-msg.error { color: var(--fatal); }
  </style>
</head>
<body>
  <div class="header">
    <div class="pr-badge">PR #${prNumber}</div>
    <h1><a href="${prUrl}" class="pr-link">${escapeHtml(prTitle)}</a></h1>
    <div class="meta">${projectKey} / ${repoName} &nbsp;|&nbsp; Model: ${escapeHtml(modelName)}</div>
  </div>

  <div class="review-body">
    ${renderedMarkdown}
  </div>

  ${postButton}

  <div class="footer">
    <span>Reviewed by GitHub Copilot (${escapeHtml(modelName)}) via Backlog AI Reviewer</span>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const postBtn = document.getElementById('post-comment-btn');
    const statusMsg = document.getElementById('post-status');

    if (postBtn) {
      postBtn.addEventListener('click', () => {
        postBtn.disabled = true;
        statusMsg.textContent = '投稿中...';
        statusMsg.className = 'status-msg';
        
        vscode.postMessage({
          type: 'postComment',
          issueKey: '${issueKey}',
          content: \`${markdown.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`
        });
      });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'postResult') {
        if (msg.success) {
          statusMsg.textContent = '✅ コメントを投稿しました';
          statusMsg.className = 'status-msg success';
        } else {
          statusMsg.textContent = '❌ 投稿失敗: ' + msg.error;
          statusMsg.className = 'status-msg error';
          postBtn.disabled = false;
        }
      }
    });
  </script>
</body>
</html>`;
  }

  private getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Error</title>
  <style>${this.getBaseStyles()}</style>
</head>
<body>
  <div class="header">
    <div class="pr-badge error">エラー</div>
    <h1>レビューに失敗しました</h1>
  </div>
  <div class="section">
    <div class="error-box">
      <pre>${escapeHtml(message)}</pre>
    </div>
  </div>
</body>
</html>`;
  }

  private getBaseStyles(): string {
    return `
      :root {
        --accent: #7C6FF7;
        --accent-muted: rgba(124, 111, 247, 0.15);
        --fatal: #FF6B6B;
        --fatal-bg: rgba(255, 107, 107, 0.12);
        --warning: #FFB347;
        --warning-bg: rgba(255, 179, 71, 0.12);
        --recommend: #64B5F6;
        --recommend-bg: rgba(100, 181, 246, 0.12);
        --praise: #66BB6A;
        --praise-bg: rgba(102, 187, 106, 0.12);
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
        font-size: 14px;
        line-height: 1.7;
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        padding: 0 0 48px 0;
        max-width: 900px;
        margin: 0 auto;
      }
      .header {
        padding: 28px 32px 20px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--accent-muted);
        margin-bottom: 8px;
      }
      .pr-badge {
        display: inline-block;
        background: var(--accent);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        padding: 2px 10px;
        border-radius: 12px;
        margin-bottom: 8px;
        letter-spacing: 0.5px;
      }
      .pr-badge.error { background: var(--fatal); }
      h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
      .pr-link { color: var(--accent); text-decoration: none; }
      .pr-link:hover { text-decoration: underline; }
      .meta { font-size: 12px; color: var(--vscode-descriptionForeground); }
      .section { padding: 16px 32px; }
      .error-box { background: var(--fatal-bg); border-left: 3px solid var(--fatal); padding: 16px; border-radius: 4px; }
      p { color: var(--vscode-descriptionForeground); }
      .footer { padding: 16px 32px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); margin-top: 32px; }
    `;
  }

  private getReviewStyles(): string {
    return `
      .review-body { padding: 8px 32px; }
      .review-body h2 {
        font-size: 16px;
        font-weight: 700;
        margin: 28px 0 12px;
        padding: 10px 16px;
        border-radius: 6px;
        border-left: 4px solid var(--accent);
      }
      .review-body h2:has-text('致命的'), h2.fatal { border-left-color: var(--fatal); background: var(--fatal-bg); }
      .review-body h2:has-text('警告'), h2.warning { border-left-color: var(--warning); background: var(--warning-bg); }
      .review-body h2:has-text('推奨'), h2.recommend { border-left-color: var(--recommend); background: var(--recommend-bg); }
      .review-body h2:has-text('称賛'), h2.praise { border-left-color: var(--praise); background: var(--praise-bg); }
      .review-body h3 { font-size: 14px; font-weight: 600; margin: 20px 0 8px; color: var(--vscode-descriptionForeground); }
      .review-body p { margin: 8px 0; line-height: 1.8; }
      .review-body ul, .review-body ol { margin: 8px 0 8px 20px; }
      .review-body li { margin: 4px 0; }
      .review-body code {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        background: var(--vscode-textCodeBlock-background);
        padding: 1px 5px;
        border-radius: 3px;
      }
      .review-body pre {
        background: var(--vscode-textCodeBlock-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        padding: 12px 16px;
        overflow-x: auto;
        margin: 12px 0;
        font-size: 12px;
        line-height: 1.6;
      }
      .review-body pre code { background: none; padding: 0; }
      .review-body blockquote {
        border-left: 3px solid var(--accent);
        padding: 4px 12px;
        margin: 8px 0;
        color: var(--vscode-descriptionForeground);
      }
      .review-body strong { font-weight: 700; }
      .review-body a { color: var(--accent); }
      /* Section color coding based on heading content */
      .fatal-section h2 { border-left-color: var(--fatal); background: var(--fatal-bg); }
      .warning-section h2 { border-left-color: var(--warning); background: var(--warning-bg); }
      .recommend-section h2 { border-left-color: var(--recommend); background: var(--recommend-bg); }
      .praise-section h2 { border-left-color: var(--praise); background: var(--praise-bg); }
    `;
  }
}

// --- Simple Markdown to HTML converter ---
function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const htmlLines: string[] = [];
  let inPre = false;
  let preBuffer: string[] = [];
  let preLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      if (!inPre) {
        inPre = true;
        preLang = line.slice(3).trim();
        preBuffer = [];
      } else {
        htmlLines.push(`<pre><code class="language-${escapeHtml(preLang)}">${escapeHtml(preBuffer.join('\n'))}</code></pre>`);
        inPre = false;
        preBuffer = [];
      }
      continue;
    }
    if (inPre) { preBuffer.push(line); continue; }

    // Headings
    if (line.startsWith('## ')) {
      const text = line.slice(3);
      const sectionClass = getSectionClass(text);
      htmlLines.push(`<div class="${sectionClass}-section"><h2>${escapeHtml(text)}</h2></div>`);
      continue;
    }
    if (line.startsWith('### ')) { htmlLines.push(`<h3>${escapeHtml(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('#### ')) { htmlLines.push(`<h4>${escapeHtml(line.slice(5))}</h4>`); continue; }
    if (line.startsWith('# ')) { htmlLines.push(`<h2>${escapeHtml(line.slice(2))}</h2>`); continue; }

    // List items
    if (line.match(/^[\-\*] /)) { htmlLines.push(`<ul><li>${inlineMarkdown(line.slice(2))}</li></ul>`); continue; }
    if (line.match(/^\d+\. /)) { htmlLines.push(`<ol><li>${inlineMarkdown(line.replace(/^\d+\. /, ''))}</li></ol>`); continue; }

    // Blockquote
    if (line.startsWith('> ')) { htmlLines.push(`<blockquote><p>${inlineMarkdown(line.slice(2))}</p></blockquote>`); continue; }

    // Horizontal rule
    if (line.match(/^---+$/)) { htmlLines.push('<hr>'); continue; }

    // Empty line
    if (line.trim() === '') { htmlLines.push('<br>'); continue; }

    htmlLines.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  return htmlLines.join('\n');
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSectionClass(heading: string): string {
  if (heading.includes('致命的')) { return 'fatal'; }
  if (heading.includes('警告')) { return 'warning'; }
  if (heading.includes('推奨')) { return 'recommend'; }
  if (heading.includes('称賛')) { return 'praise'; }
  return 'neutral';
}
