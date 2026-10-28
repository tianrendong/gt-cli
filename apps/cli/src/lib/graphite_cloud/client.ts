import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import { ExitFailedError } from '../errors';

// Existing-PR update contract: @withgraphite/graphite-cli-routes@0.31.0.
// Native Graphite 1.8.6 submits one PR per request to this production route.
// Its array-shaped schema does not imply batch support: multi-PR requests fail.
// This is a CLI compatibility API, not a promise of a stable public API.
export const GRAPHITE_SUBMIT_URL =
  'https://api.graphite.com/v1/graphite/submit/pull-requests';
export type GraphiteUpdate = {
  action: 'update';
  head: string;
  headSha: string;
  base: string;
  baseSha: string;
  prNumber: number;
};
export type GraphiteRequest = {
  repoOwner: string;
  repoName: string;
  trunkBranchName: string;
  prs: [GraphiteUpdate];
};
export type GraphiteReply = { status: number; body: unknown };
export type GraphiteTransport = (
  payload: GraphiteRequest,
  token: string
) => Promise<GraphiteReply>;

export class GraphiteCloudError extends ExitFailedError {
  constructor(
    readonly kind: 'auth' | 'transport' | 'protocol' | 'rejected',
    message: string
  ) {
    super(message);
  }
}

export function graphiteToken(env: NodeJS.ProcessEnv = process.env): string {
  let token: unknown = env.GT_GRAPHITE_TOKEN;
  if (token === undefined) {
    if (env.GRAPHITE_PROFILE)
      throw new GraphiteCloudError(
        'auth',
        'Custom Graphite profiles are not supported for cloud mirroring. Supply a production GT_GRAPHITE_TOKEN explicitly.'
      );
    const directory =
      env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), '.config');
    if (!path.isAbsolute(directory))
      throw new GraphiteCloudError(
        'auth',
        'XDG_CONFIG_HOME must be absolute for Graphite authentication.'
      );
    const file = path.join(directory, 'graphite/auth');
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid() ||
        stat.mode & 0o022 ||
        stat.size > 65536
      )
        throw Error('Unsafe authentication file');
      token = JSON.parse(fs.readFileSync(file, 'utf8')).authToken;
    } catch {
      throw new GraphiteCloudError(
        'auth',
        'Graphite authentication is missing or unreadable. Sign in with native Graphite or set GT_GRAPHITE_TOKEN; no GitHub submission was started.'
      );
    }
  }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token))
    throw new GraphiteCloudError(
      'auth',
      'Invalid Graphite credential. Refresh native Graphite authentication or GT_GRAPHITE_TOKEN.'
    );
  return token;
}

/** No redirects, token in headers only, bounded responses, and a total deadline. */
export function sendGraphite(
  payload: GraphiteRequest,
  token: string,
  timeoutMs = 30_000
): Promise<GraphiteReply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let agent: HttpsProxyAgent<string> | undefined;
    try {
      const proxy = getProxyForUrl(GRAPHITE_SUBMIT_URL);
      if (proxy) {
        if (!['http:', 'https:'].includes(new URL(proxy).protocol))
          throw Error('Unsupported proxy');
        agent = new HttpsProxyAgent(proxy, { rejectUnauthorized: true });
      }
    } catch {
      reject(
        new GraphiteCloudError(
          'transport',
          'Invalid Graphite proxy configuration. Credentials were not sent.'
        )
      );
      return;
    }
    let settled = false;
    const finish = (error?: GraphiteCloudError, reply?: GraphiteReply) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      agent?.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    const interrupted = () =>
      finish(
        new GraphiteCloudError(
          'transport',
          'Graphite response was interrupted. Its remote outcome is unknown; rerun submit to retry.'
        )
      );
    const request = https.request(
      GRAPHITE_SUBMIT_URL,
      {
        method: 'POST',
        agent,
        rejectUnauthorized: true,
        headers: {
          authorization: `token ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            finish(
              new GraphiteCloudError(
                'protocol',
                'Graphite response exceeded its size limit. Retry after checking service status.'
              )
            );
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          let parsed: unknown;
          if (status === 200) {
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              finish(
                new GraphiteCloudError(
                  'protocol',
                  'Graphite returned invalid JSON.'
                )
              );
              return;
            }
          }
          finish(undefined, { status, body: parsed });
        });
        response.on('error', interrupted);
        response.on('aborted', interrupted);
      }
    );
    const timer = setTimeout(() => {
      finish(
        new GraphiteCloudError(
          'transport',
          'Graphite request timed out. Its remote outcome is unknown; rerun submit to retry.'
        )
      );
      request.destroy();
    }, timeoutMs);
    request.on('error', () =>
      finish(
        new GraphiteCloudError(
          'transport',
          'Graphite request failed. Check network/proxy settings and rerun submit; its remote outcome may be unknown.'
        )
      )
    );
    request.on('close', interrupted);
    request.end(body);
  });
}

export class GraphiteCloudClient {
  constructor(
    private readonly token: string,
    private readonly transport: GraphiteTransport = sendGraphite
  ) {}

  async update(payload: GraphiteRequest): Promise<void> {
    if (!Array.isArray(payload.prs) || payload.prs.length !== 1)
      throw new GraphiteCloudError(
        'protocol',
        'Graphite mirroring requires exactly one existing PR per request.'
      );
    if (
      payload.prs.some(
        (pr) =>
          pr?.action !== 'update' ||
          !Number.isSafeInteger(pr.prNumber) ||
          pr.prNumber <= 0 ||
          Object.keys(pr).sort().join(',') !==
            'action,base,baseSha,head,headSha,prNumber'
      ) ||
      Object.keys(payload).sort().join(',') !==
        'prs,repoName,repoOwner,trunkBranchName'
    )
      throw new GraphiteCloudError(
        'protocol',
        'Only existing-PR updates without content/draft/reviewer edits may be mirrored to Graphite.'
      );
    let reply: GraphiteReply;
    try {
      reply = await this.transport(payload, this.token);
    } catch (error) {
      if (error instanceof GraphiteCloudError) throw error;
      throw new GraphiteCloudError(
        'transport',
        'Graphite transport failed. Its outcome may be unknown; rerun submit to retry.'
      );
    }
    if ([401, 403].includes(reply.status))
      throw new GraphiteCloudError(
        'auth',
        `Graphite rejected authentication or repository access (HTTP ${reply.status}). Refresh Graphite authorization and retry.`
      );
    if (reply.status !== 200)
      throw new GraphiteCloudError(
        'transport',
        `Graphite submission failed (HTTP ${reply.status}). GitHub work was kept; retry when Graphite is available.`
      );
    const result = reply.body as {
      prs?: Array<{
        status?: unknown;
        head?: unknown;
        prNumber?: unknown;
        prURL?: unknown;
      }>;
    };
    const invalid = (): never => {
      throw new GraphiteCloudError(
        'protocol',
        'Graphite returned an unexpected result. This PR was not accepted as a successful mirror.'
      );
    };
    if (!Array.isArray(result?.prs) || result.prs.length !== 1) invalid();
    const pr = payload.prs[0];
    const response = result.prs![0];
    if (response?.head !== pr.head) invalid();
    if (response.status === 'error') {
      if (response.prNumber !== undefined && response.prNumber !== pr.prNumber)
        invalid();
      throw new GraphiteCloudError(
        'rejected',
        `Graphite rejected PR #${pr.prNumber}. Retry to mirror remaining PRs.`
      );
    }
    if (
      response.status !== 'updated' ||
      response.prNumber !== pr.prNumber ||
      typeof response.prURL !== 'string'
    )
      invalid();
  }
}
