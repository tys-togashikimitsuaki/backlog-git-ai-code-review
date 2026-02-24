import * as https from 'https';
import * as http from 'http';

/**
 * スペースキーの入力値からホスト名を解決する
 */
export function resolveBacklogHost(spaceKey: string, domain: string = 'backlog.jp'): string {
    const urlMatch = spaceKey.match(/https?:\/\/([^/]+)/);
    if (urlMatch) { return urlMatch[1]; }
    if (spaceKey.includes('.backlog.')) { return spaceKey; }
    return `${spaceKey}.${domain}`;
}

export interface BacklogIssue {
    id: number;
    issueKey: string;
    summary: string;
    description: string;
    status: { name: string };
    assignee: { name: string } | null;
    createdUser: { name: string };
    created: string;
    updated: string;
}

export interface BacklogIssueComment {
    id: number;
    content: string;
    createdUser: { name: string };
    created: string;
}

export interface BacklogRepository {
    id: number;
    name: string;
    description: string;
    httpUrl: string;
}

export interface BacklogBranch {
    name: string;
    commit: { id: string; message: string };
}

export interface BacklogPullRequest {
    id: number;
    projectId: number;
    repositoryId: number;
    number: number;
    summary: string;
    description: string;
    base: string;
    branch: string;
    status: { id: number; name: string };
    assignee: { name: string } | null;
    issue: { issueKey: string; summary: string; description: string } | null;
    createdUser: { name: string };
    created: string;
    updated: string;
}

export interface BacklogFileEntry {
    name: string;
    type: 'blob' | 'tree';
}

export interface BacklogFileContent {
    name: string;
    content: string; // Base64 encoded
}

export class BacklogClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    readonly host: string;

    constructor(spaceKey: string, apiKey: string, domain: string = 'backlog.jp') {
        this.host = resolveBacklogHost(spaceKey, domain);
        this.baseUrl = `https://${this.host}/api/v2`;
        this.apiKey = apiKey;
    }

    private request<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: any): Promise<T> {
        return new Promise((resolve, reject) => {
            const sep = path.includes('?') ? '&' : '?';
            const url = `${this.baseUrl}${path}${sep}apiKey=${this.apiKey}`;
            const parsedUrl = new URL(url);
            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                method: method,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            };

            const req = https.request(options, (res: http.IncomingMessage) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`Backlog API error ${res.statusCode}: ${data}`));
                            return;
                        }
                        resolve(JSON.parse(data) as T);
                    } catch (e) {
                        reject(new Error(`Backlog API parse error: ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);

            if (body) {
                // form-urlencoded for Backlog POST
                const params = new URLSearchParams();
                for (const key in body) {
                    params.append(key, body[key]);
                }
                req.write(params.toString());
            }

            req.end();
        });
    }

    /** プロジェクト一覧 */
    async listProjects(): Promise<{ id: number; projectKey: string; name: string }[]> {
        return this.request('/projects');
    }

    /** projectKey/IDをGit APIで使うprojectKeyに正規化 */
    private async resolveProjectKey(projectKeyOrId: string | number): Promise<string> {
        if (typeof projectKeyOrId === 'number') {
            const project = await this.getProject(projectKeyOrId);
            return project.projectKey;
        }

        const numeric = Number(projectKeyOrId);
        if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
            const project = await this.getProject(numeric);
            return project.projectKey;
        }

        return projectKeyOrId;
    }

    /** Gitリポジトリ一覧 */
    async listRepositories(projectKeyOrId: string | number): Promise<BacklogRepository[]> {
        const projectKey = await this.resolveProjectKey(projectKeyOrId);
        return this.request(`/projects/${enc(projectKey)}/git/repositories`);
    }

    /** リポジトリ名/IDを数値IDに解決 */
    private async resolveRepositoryId(
        projectKeyOrId: string | number,
        repoIdOrName: string | number
    ): Promise<number> {
        if (typeof repoIdOrName === 'number') {
            return repoIdOrName;
        }

        const numeric = Number(repoIdOrName);
        if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
            return numeric;
        }

        const repos = await this.listRepositories(projectKeyOrId);
        const matched = repos.find(r => r.name === repoIdOrName);
        if (!matched) {
            throw new Error(`Repository not found: ${repoIdOrName}`);
        }
        return matched.id;
    }

    /** ブランチ一覧 */
    async listBranches(projectKeyOrId: string | number, repoIdOrName: string | number): Promise<BacklogBranch[]> {
        const projectKey = await this.resolveProjectKey(projectKeyOrId);
        const repoId = await this.resolveRepositoryId(projectKeyOrId, repoIdOrName);
        return this.request(
            `/projects/${enc(projectKey)}/git/repositories/${repoId}/branches`
        );
    }

    /** プルリクエスト一覧 (statusId: 1=open, 2=closed, 3=merged) */
    async listPullRequests(
        projectKeyOrId: string | number,
        repoIdOrName: string | number,
        statusId: number = 1
    ): Promise<BacklogPullRequest[]> {
        const projectKey = await this.resolveProjectKey(projectKeyOrId);
        const repoId = await this.resolveRepositoryId(projectKeyOrId, repoIdOrName);
        return this.request(
            `/projects/${enc(projectKey)}/git/repositories/${repoId}/pullRequests?statusId[]=${statusId}`
        );
    }

    /** プルリクエスト詳細 */
    async getPullRequest(
        projectKeyOrId: string | number,
        repoIdOrName: string | number,
        prNumber: number
    ): Promise<BacklogPullRequest> {
        const projectKey = await this.resolveProjectKey(projectKeyOrId);
        const repoId = await this.resolveRepositoryId(projectKeyOrId, repoIdOrName);
        return this.request(
            `/projects/${enc(projectKey)}/git/repositories/${repoId}/pullRequests/${prNumber}`
        );
    }

    /** 課題情報 */
    async getIssue(issueKey: string): Promise<BacklogIssue> {
        return this.request(`/issues/${enc(issueKey)}`);
    }

    /** 課題のコメント一覧 */
    async getIssueComments(issueKey: string, count: number = 20): Promise<BacklogIssueComment[]> {
        return this.request(`/issues/${enc(issueKey)}/comments?count=${count}&order=desc`);
    }

    /** キーワードで課題を検索 (projectIdは必須。複数指定可) */
    async searchIssues(
        projectId: number,
        keyword: string,
        count: number = 100
    ): Promise<BacklogIssue[]> {
        // 全件取得したい場合もあるため count を増やし、新しい順にソートする
        return this.request(
            `/issues?projectId[]=${projectId}&keyword=${enc(keyword)}&count=${count}&sort=created&order=desc`
        );
    }

    /** プロジェクト詳細 */
    async getProject(projectKeyOrId: string | number): Promise<{ id: number; projectKey: string; name: string }> {
        return this.request(`/projects/${enc(String(projectKeyOrId))}`);
    }

    /**
     * ディレクトリ内のファイル/フォルダ一覧を取得
     */
    async listFiles(
        projectKeyOrId: string | number,
        repoIdOrName: string | number,
        ref: string,
        dirPath: string = ''
    ): Promise<BacklogFileEntry[]> {
        const projectKey = await this.resolveProjectKey(projectKeyOrId);
        const repoId = await this.resolveRepositoryId(projectKeyOrId, repoIdOrName);
        const pathParam = dirPath ? `&path=${enc(dirPath)}` : '';
        return this.request(
            `/projects/${enc(projectKey)}/git/repositories/${repoId}/contents?ref=${enc(ref)}${pathParam}`
        );
    }

    /**
     * ファイル内容を取得（Base64デコード済み）
     */
    async getFileContent(
        projectKeyOrId: string | number,
        repoIdOrName: string | number,
        ref: string,
        filePath: string
    ): Promise<string> {
        const projectKey = await this.resolveProjectKey(projectKeyOrId);
        const repoId = await this.resolveRepositoryId(projectKeyOrId, repoIdOrName);
        const encoded = await this.request<BacklogFileContent>(
            `/projects/${enc(projectKey)}/git/repositories/${repoId}/contents?path=${enc(filePath)}&ref=${enc(ref)}`
        );
        return Buffer.from(encoded.content, 'base64').toString('utf-8');
    }

    /** 課題にコメントを追加 */
    async addIssueComment(issueKey: string, content: string): Promise<BacklogIssueComment> {
        return this.request(`/issues/${enc(issueKey)}/comments`, 'POST', { content });
    }
}

function enc(s: string): string {
    return encodeURIComponent(s);
}
