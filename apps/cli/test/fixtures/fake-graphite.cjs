// Test-only preload. No production endpoint override or credential required.
const fs = require('fs');
const nock = require('nock');
const file = process.env.GT_FAKE_GRAPHITE;
if (!file) throw Error('GT_FAKE_GRAPHITE fixture file required');
nock.disableNetConnect();
nock('https://api.graphite.com')
  .persist()
  .post('/v1/graphite/submit/pull-requests')
  .reply(function (_uri, body) {
    const state = JSON.parse(fs.readFileSync(file));
    if (this.req.headers.authorization !== 'token fixture-token')
      return [401, {}];
    if (
      body.repoOwner !== 'test' ||
      body.repoName !== 'repo' ||
      !Array.isArray(body.prs) ||
      body.prs.length !== 1 ||
      body.prs[0]?.action !== 'update'
    )
      return [400, {}];
    state.requests.push(body);
    const prs = body.prs.map((pr) => {
      if (pr.prNumber === state.failPr && state.remaining > 0) {
        state.remaining--;
        return { head: pr.head, status: 'error' };
      }
      return {
        head: pr.head,
        prNumber: pr.prNumber,
        prURL: `https://app.graphite.com/github/pr/test/repo/${pr.prNumber}`,
        status: 'updated',
      };
    });
    fs.writeFileSync(file, JSON.stringify(state));
    return [200, { prs }];
  });
