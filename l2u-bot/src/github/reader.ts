import { run } from '../exec.js';

/**
 * Read-only wrapper around the `gh` CLI.
 * The target repository is fixed at construction time and the model cannot change it.
 */
export class GithubReader {
  constructor(private readonly repo: string) {}

  private async gh(args: readonly string[]): Promise<string> {
    const { stdout, stderr, code } = await run('gh', [...args, '--repo', this.repo], {
      timeoutMs: 30_000,
    });
    if (code !== 0) throw new Error(`gh command failed (code ${code}): ${stderr.trim() || stdout.trim()}`);
    return stdout;
  }

  listIssues(state = 'open', labels?: string, limit = 30): Promise<string> {
    const args = [
      'issue', 'list',
      '--state', state,
      '--limit', String(limit),
      '--json', 'number,title,state,labels,updatedAt,author',
    ];
    if (labels) args.push('--label', labels);
    return this.gh(args);
  }

  getIssue(issueNumber: number): Promise<string> {
    return this.gh([
      'issue', 'view', String(issueNumber),
      '--json', 'number,title,state,body,labels,comments,createdAt,updatedAt,author',
    ]);
  }

  listPrs(state = 'open', limit = 30): Promise<string> {
    return this.gh([
      'pr', 'list',
      '--state', state,
      '--limit', String(limit),
      '--json', 'number,title,state,author,updatedAt,isDraft,headRefName',
    ]);
  }

  getPr(prNumber: number): Promise<string> {
    return this.gh([
      'pr', 'view', String(prNumber),
      '--json', 'number,title,state,body,author,files,comments,reviews,additions,deletions,headRefName,baseRefName',
    ]);
  }

  getPrDiff(prNumber: number): Promise<string> {
    return this.gh(['pr', 'diff', String(prNumber)]);
  }

  searchIssues(query: string, limit = 20): Promise<string> {
    return this.gh([
      'issue', 'list',
      '--search', query,
      '--limit', String(limit),
      '--json', 'number,title,state,labels,updatedAt',
    ]);
  }
}
