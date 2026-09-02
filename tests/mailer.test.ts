import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { MailerService, DigestReportData } from '../src/services/mailer.js';

describe('MailerService & Webhook Notifications', () => {
  let server: http.Server;
  let baseUrl: string;
  let receivedRequests: { [key: string]: any } = {};

  const sampleReport: DigestReportData = {
    reportDate: 'September 2, 2026',
    targetRepoUrl: 'https://github.com/Divyanshu-kumar14/fluent.git',
    targetBranch: 'main',
    timeWindow: 'Last 24 Hours',
    totalCommits: 3,
    totalFilesChanged: 8,
    authors: [{ name: 'Divyanshu', email: 'dev@example.com', commitCount: 3, summary: 'Engine improvements' }],
    executiveSummary: 'Major architecture refactor and security enhancements.',
    categorizedChanges: {
      features: ['Multi-channel webhooks'],
      fixes: ['Path traversal guard'],
      security: ['Environment secret stripping'],
      refactoring: [],
      other: [],
    },
    securityVerdict: 'CLEAN',
    securitySummary: 'No secrets detected in commit history.',
    vulnerabilities: [],
    commits: [
      { hash: '1234567890abcdef', shortHash: '1234567', author: 'Divyanshu', email: 'dev@example.com', date: '2026-09-02', message: 'feat: add webhooks', body: '', files: ['src/services/mailer.ts'] },
    ],
  };

  beforeEach(async () => {
    receivedRequests = {};
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedRequests[req.url || '/'] = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    server.close();
  });

  it('should generate responsive HTML email containing report metadata', () => {
    const mailer = new MailerService();
    const html = mailer.generateHtmlEmail(sampleReport);

    expect(html).toContain('Divyanshu-kumar14/fluent');
    expect(html).toContain('September 2, 2026');
    expect(html).toContain('Major architecture refactor');
    expect(html).toContain('CLEAN');
    expect(html).toContain('1234567');
  });

  it('should generate structured Markdown report', () => {
    const mailer = new MailerService();
    const md = mailer.generateMarkdownReport(sampleReport);

    expect(md).toContain('# 🔮 PRism Daily Commit & Security Digest');
    expect(md).toContain('## 🛡️ Security & Vulnerability Verdict: CLEAN');
    expect(md).toContain('### 🚀 Features & Enhancements');
    expect(md).toContain('Multi-channel webhooks');
  });

  it('should dispatch formatted payload to Slack webhook', async () => {
    const mailer = new MailerService();
    await mailer.sendSlackWebhook(sampleReport, `${baseUrl}/slack`);

    expect(receivedRequests['/slack']).toBeDefined();
    expect(receivedRequests['/slack'].blocks).toBeDefined();
    expect(receivedRequests['/slack'].blocks[0].text.text).toContain('PRism Daily Digest');
  });

  it('should dispatch formatted embed to Discord webhook', async () => {
    const mailer = new MailerService();
    await mailer.sendDiscordWebhook(sampleReport, `${baseUrl}/discord`);

    expect(receivedRequests['/discord']).toBeDefined();
    expect(receivedRequests['/discord'].embeds).toHaveLength(1);
    expect(receivedRequests['/discord'].embeds[0].color).toBe(0x10b981);
    expect(receivedRequests['/discord'].embeds[0].title).toContain('PRism Daily Digest');
  });

  it('should dispatch JSON payload to Generic webhook', async () => {
    const mailer = new MailerService();
    await mailer.sendGenericWebhook(sampleReport, `${baseUrl}/webhook`);

    expect(receivedRequests['/webhook']).toBeDefined();
    expect(receivedRequests['/webhook'].event).toBe('prism.digest.completed');
    expect(receivedRequests['/webhook'].data.totalCommits).toBe(3);
  });
});
