import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  TestRunReport,
  TestCaseResult,
  ScreenshotCapture,
  Issue,
} from "../types.js";

async function screenshotToBase64(sc: ScreenshotCapture): Promise<string> {
  if (sc.buffer) return Buffer.from(sc.buffer).toString("base64");
  try {
    const buf = await readFile(sc.path);
    return buf.toString("base64");
  } catch {
    return "";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function verdictBadge(verdict: string): string {
  const colors: Record<string, string> = {
    pass: "#16a34a",
    fail: "#dc2626",
    partial: "#ca8a04",
    blocked: "#6b7280",
    skipped: "#9ca3af",
  };
  const color = colors[verdict] ?? "#6b7280";
  return `<span class="badge" style="background:${color}">${verdict.toUpperCase()}</span>`;
}

function severityBadge(severity: string): string {
  const colors: Record<string, string> = {
    critical: "#dc2626",
    major: "#ea580c",
    minor: "#ca8a04",
    cosmetic: "#6b7280",
  };
  const color = colors[severity] ?? "#6b7280";
  return `<span class="badge badge-sm" style="background:${color}">${severity}</span>`;
}

function renderIssues(issues: Issue[]): string {
  if (issues.length === 0) return "";
  const rows = issues
    .map(
      (i) =>
        `<div class="issue">${severityBadge(i.severity)} ${escapeHtml(i.description)}</div>`
    )
    .join("\n");
  return `<div class="issues"><h4>Issues</h4>${rows}</div>`;
}

async function renderCard(result: TestCaseResult): Promise<string> {
  const tc = result.testCase;
  const ev = result.evaluation;
  const exec = result.execution;

  const actionLog = exec.actionResults
    .map((ar) => {
      const icon = ar.success ? "&#10003;" : "&#10007;";
      const cls = ar.success ? "action-ok" : "action-fail";
      return `<div class="${cls}">${icon} [${ar.action.type}] ${escapeHtml(ar.action.description)}${ar.error ? ` — <em>${escapeHtml(ar.error)}</em>` : ""}</div>`;
    })
    .join("\n");

  const screenshotImgs: string[] = [];
  for (const sc of exec.screenshots) {
    const b64 = await screenshotToBase64(sc);
    if (b64) {
      screenshotImgs.push(
        `<div class="screenshot-item"><img src="data:image/png;base64,${b64}" alt="${escapeHtml(sc.description)}" /><p>${escapeHtml(sc.description)}</p></div>`
      );
    }
  }

  const consoleErrs =
    exec.consoleErrors.length > 0
      ? `<div class="console-errors"><h4>Console Errors</h4><pre>${escapeHtml(exec.consoleErrors.join("\n"))}</pre></div>`
      : "";

  return `
<div class="card" data-verdict="${ev.verdict}">
  <div class="card-header" onclick="this.parentElement.classList.toggle('expanded')">
    <div class="card-title">
      <span class="case-id">${escapeHtml(tc.id)}</span>
      ${verdictBadge(ev.verdict)}
      <span class="confidence">${Math.round(ev.confidence * 100)}%</span>
      <span class="priority-tag ${tc.priority}">${tc.priority === "must_have" ? "MUST" : "NICE"}</span>
    </div>
    <div class="card-desc">${escapeHtml(tc.description)}</div>
    <div class="card-meta">${(exec.durationMs / 1000).toFixed(1)}s</div>
  </div>
  <div class="card-body">
    <div class="reasoning"><h4>Evaluation</h4><p>${escapeHtml(ev.reasoning)}</p></div>
    ${renderIssues(ev.issues)}
    <details class="action-log"><summary>Action Log (${exec.actionResults.length} actions)</summary>${actionLog}</details>
    ${screenshotImgs.length > 0 ? `<details class="screenshots"><summary>Screenshots (${screenshotImgs.length})</summary><div class="screenshot-grid">${screenshotImgs.join("\n")}</div></details>` : ""}
    ${consoleErrs}
  </div>
</div>`;
}

export async function generateHTMLReport(
  report: TestRunReport,
  outputPath: string
): Promise<string> {
  const s = report.summary;
  const cards: string[] = [];
  for (const r of report.results) {
    cards.push(await renderCard(r));
  }

  const duration =
    (new Date(report.endTime).getTime() -
      new Date(report.startTime).getTime()) /
    1000;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Party Report — ${escapeHtml(report.testPlanName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.5;padding:2rem}
h1{font-size:1.5rem;font-weight:700;margin-bottom:.25rem}
h4{font-size:.85rem;font-weight:600;margin-bottom:.5rem;color:#94a3b8}
.header{margin-bottom:2rem}
.header p{color:#94a3b8;font-size:.875rem}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin-bottom:2rem}
.stat{background:#1e293b;border-radius:.75rem;padding:1rem;text-align:center}
.stat .value{font-size:1.75rem;font-weight:700}
.stat .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
.stat-pass .value{color:#16a34a}
.stat-fail .value{color:#dc2626}
.stat-partial .value{color:#ca8a04}
.stat-rate .value{color:#3b82f6}
.filters{display:flex;gap:.5rem;margin-bottom:1.5rem;flex-wrap:wrap}
.filters button{background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:.4rem .9rem;border-radius:.5rem;cursor:pointer;font-size:.8rem;transition:all .15s}
.filters button:hover,.filters button.active{background:#334155;border-color:#3b82f6}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:.25rem;color:#fff;font-size:.7rem;font-weight:700;letter-spacing:.03em;vertical-align:middle}
.badge-sm{font-size:.65rem;padding:.1rem .35rem}
.card{background:#1e293b;border-radius:.75rem;margin-bottom:.75rem;overflow:hidden;border:1px solid #334155;transition:border-color .15s}
.card:hover{border-color:#475569}
.card.expanded .card-body{display:block}
.card-header{padding:1rem 1.25rem;cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.card-title{display:flex;align-items:center;gap:.5rem;flex:1;min-width:200px}
.case-id{font-weight:700;font-size:.85rem;color:#3b82f6}
.confidence{font-size:.75rem;color:#94a3b8}
.priority-tag{font-size:.6rem;padding:.1rem .35rem;border-radius:.2rem;font-weight:700;text-transform:uppercase}
.priority-tag.must_have{background:#7c2d12;color:#fdba74}
.priority-tag.nice_to_have{background:#1e3a5f;color:#93c5fd}
.card-desc{width:100%;font-size:.85rem;color:#cbd5e1}
.card-meta{font-size:.75rem;color:#64748b}
.card-body{display:none;padding:0 1.25rem 1.25rem;border-top:1px solid #334155;margin-top:.75rem;padding-top:1rem}
.reasoning p{font-size:.85rem;color:#cbd5e1;margin-bottom:.75rem}
.issues{margin-bottom:.75rem}
.issue{font-size:.8rem;margin-bottom:.35rem;display:flex;align-items:center;gap:.4rem}
details{margin-bottom:.75rem}
summary{cursor:pointer;font-size:.8rem;font-weight:600;color:#94a3b8;margin-bottom:.5rem}
.action-ok{font-size:.8rem;color:#16a34a;margin-bottom:.2rem}
.action-fail{font-size:.8rem;color:#dc2626;margin-bottom:.2rem}
.screenshot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem}
.screenshot-item img{max-width:100%;border-radius:.5rem;border:1px solid #334155}
.screenshot-item p{font-size:.75rem;color:#94a3b8;margin-top:.25rem}
.console-errors pre{font-size:.75rem;background:#1a0000;color:#fca5a5;padding:.75rem;border-radius:.5rem;overflow-x:auto;white-space:pre-wrap}
</style>
</head>
<body>
<div class="header">
  <h1>QA Party Report: ${escapeHtml(report.testPlanName)}</h1>
  <p>${escapeHtml(report.baseUrl)} &mdash; ${escapeHtml(report.startTime)} &mdash; ${duration.toFixed(0)}s total &mdash; Run ${escapeHtml(report.runId)}</p>
</div>

<div class="summary">
  <div class="stat"><div class="value">${s.total}</div><div class="label">Total</div></div>
  <div class="stat stat-pass"><div class="value">${s.passed}</div><div class="label">Passed</div></div>
  <div class="stat stat-fail"><div class="value">${s.failed}</div><div class="label">Failed</div></div>
  <div class="stat stat-partial"><div class="value">${s.partial}</div><div class="label">Partial</div></div>
  <div class="stat"><div class="value">${s.blocked}</div><div class="label">Blocked</div></div>
  <div class="stat"><div class="value">${s.skipped}</div><div class="label">Skipped</div></div>
  <div class="stat stat-rate"><div class="value">${Math.round(s.passRate)}%</div><div class="label">Pass Rate</div></div>
</div>

<div class="filters">
  <button class="active" onclick="filterCards('all',this)">All</button>
  <button onclick="filterCards('pass',this)">Passed</button>
  <button onclick="filterCards('fail',this)">Failed</button>
  <button onclick="filterCards('partial',this)">Partial</button>
  <button onclick="filterCards('blocked',this)">Blocked</button>
</div>

${cards.join("\n")}

<script>
function filterCards(verdict, btn) {
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.card').forEach(c => {
    c.style.display = verdict === 'all' || c.dataset.verdict === verdict ? '' : 'none';
  });
}
</script>
</body>
</html>`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");
  return outputPath;
}
