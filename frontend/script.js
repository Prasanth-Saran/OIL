/**
 * SIF Safety Intelligence Platform - Pure Vanilla JavaScript Client
 * Oil India Limited (OIL) HSE Decision-Support System
 */

// Application State
const state = {
  stagedFiles: [],
  activeFilter: 'all',
  searchQuery: '',
  sortBy: 'priority_rank',
  activeJobId: null,
  pollInterval: null,
  activeReportId: null,
  reports: []
};

// DOM Elements
const elements = {
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  btnBrowse: document.getElementById('btn-browse'),
  stagedBar: document.getElementById('staged-files-bar'),
  stagedCount: document.getElementById('staged-count'),
  stagedSize: document.getElementById('staged-size'),
  btnRemoveSelected: document.getElementById('btn-remove-selected'),
  btnStartAnalyze: document.getElementById('btn-start-analyze'),
  btnLoadSample: document.getElementById('btn-load-sample'),
  btnClearAll: document.getElementById('btn-clear-all'),

  // Progress
  progressSection: document.getElementById('progress-section'),
  progressCounter: document.getElementById('progress-counter'),
  progressBarFill: document.getElementById('progress-bar-fill'),
  progressCurrentFile: document.getElementById('progress-current-file'),
  progressCurrentStep: document.getElementById('progress-current-step'),
  progressBadge: document.getElementById('progress-badge'),

  // Metrics
  metricTotal: document.getElementById('metric-total'),
  metricSif: document.getElementById('metric-sif'),
  metricCritical: document.getElementById('metric-critical'),
  metricHigh: document.getElementById('metric-high'),
  metricMedium: document.getElementById('metric-medium'),
  metricLow: document.getElementById('metric-low'),

  // Filter & Search
  filterBar: document.getElementById('filter-bar'),
  tableSearch: document.getElementById('table-search'),
  tableSort: document.getElementById('table-sort'),
  reportsTableBody: document.getElementById('reports-table-body'),

  // Charts
  typeBars: document.getElementById('type-bars'),
  hazardList: document.getElementById('hazard-list'),

  // Modal
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalCloseBtn: document.getElementById('modal-close-btn'),
  modalReportTitle: document.getElementById('modal-report-title'),
  modalRiskBadge: document.getElementById('modal-risk-badge'),
  modalRiskScore: document.getElementById('modal-risk-score'),
  modalSifBadge: document.getElementById('modal-sif-badge'),
  modalPriorityRank: document.getElementById('modal-priority-rank'),
  modalMetaType: document.getElementById('modal-meta-type'),
  modalMetaLocation: document.getElementById('modal-meta-location'),
  modalMetaDate: document.getElementById('modal-meta-date'),
  modalMetaFilename: document.getElementById('modal-meta-filename'),
  modalReportText: document.getElementById('modal-report-text'),
  modalExplanation: document.getElementById('modal-explanation'),
  modalFactorsGrid: document.getElementById('modal-factors-grid'),
  modalSuggestionsList: document.getElementById('modal-suggestions-list'),
  reviewForm: document.getElementById('review-form'),
  reviewStatus: document.getElementById('review-status'),
  reviewerName: document.getElementById('reviewer-name'),
  reviewComment: document.getElementById('review-comment'),
  modalReviewedStamp: document.getElementById('modal-reviewed-stamp'),

  // Status
  systemStatusText: document.getElementById('system-status-text'),
  lastAnalysisTime: document.getElementById('last-analysis-time'),
  toastContainer: document.getElementById('toast-container')
};

// Utilities
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function showToast(message, duration = 3500) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// Resilient API Fetch Helper with explicit JSON checking and non-JSON safety
async function fetchJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (netErr) {
    throw new Error(`Could not connect to ${url}. Please ensure the server is running.`);
  }

  const contentType = res.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}: ${res.statusText}`);
    }
    throw new Error(`Expected JSON but received ${contentType || 'non-JSON response'}`);
  }

  const data = await res.json();
  if (!res.ok) {
    const errorMsg = data.error || data.message || `Request failed with status ${res.status}`;
    throw new Error(errorMsg);
  }
  return data;
}

// Staged Files Management
function updateStagedFilesUI() {
  if (state.stagedFiles.length > 0) {
    elements.stagedBar.style.display = 'flex';
    const totalSize = state.stagedFiles.reduce((acc, f) => acc + f.size, 0);
    elements.stagedCount.textContent = `${state.stagedFiles.length} file${state.stagedFiles.length > 1 ? 's' : ''} selected`;
    elements.stagedSize.textContent = `(${formatBytes(totalSize)})`;
  } else {
    elements.stagedBar.style.display = 'none';
  }
}

function handleFilesAdded(files) {
  const validExts = ['pdf', 'docx', 'txt', 'zip'];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = file.name.split('.').pop().toLowerCase();
    if (validExts.includes(ext)) {
      state.stagedFiles.push(file);
    } else {
      showToast(`Skipped ${file.name}: Only PDF, DOCX, TXT, and ZIP are supported.`);
    }
  }
  updateStagedFilesUI();
}

// Drag & Drop Listeners
elements.dropZone.addEventListener('click', () => elements.fileInput.click());
elements.btnBrowse.addEventListener('click', (e) => {
  e.stopPropagation();
  elements.fileInput.click();
});

elements.fileInput.addEventListener('change', (e) => {
  if (e.target.files) {
    handleFilesAdded(e.target.files);
    elements.fileInput.value = '';
  }
});

['dragenter', 'dragover'].forEach(name => {
  elements.dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(name => {
  elements.dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.remove('dragover');
  });
});

elements.dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files) {
    handleFilesAdded(e.dataTransfer.files);
  }
});

elements.btnRemoveSelected.addEventListener('click', () => {
  state.stagedFiles = [];
  updateStagedFilesUI();
});

// Upload & Analyze Workflow
elements.btnStartAnalyze.addEventListener('click', async () => {
  if (state.stagedFiles.length === 0) return;

  try {
    elements.btnStartAnalyze.disabled = true;
    elements.btnStartAnalyze.textContent = 'Uploading...';

    const formData = new FormData();
    state.stagedFiles.forEach(f => formData.append('files', f));

    const uploadData = await fetchJson('/api/upload', {
      method: 'POST',
      body: formData
    });

    showToast(`Uploaded ${uploadData.uploaded_count} reports. Starting safety analysis...`);

    // Clear staged files
    state.stagedFiles = [];
    updateStagedFilesUI();

    // Start background analysis
    const analyzeData = await fetchJson('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report_ids: uploadData.report_ids })
    });

    if (analyzeData.job_id) {
      startJobPolling(analyzeData.job_id, analyzeData.total);
    } else {
      showToast('All reports are already analyzed.');
      loadDashboard();
      loadReports();
    }
  } catch (err) {
    console.error(err);
    showToast(`Error: ${err.message}`);
  } finally {
    elements.btnStartAnalyze.disabled = false;
    elements.btnStartAnalyze.innerHTML = `
      <span>Analyze Reports</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
    `;
  }
});

// Load OIL Sample Batch
elements.btnLoadSample.addEventListener('click', async () => {
  try {
    elements.btnLoadSample.disabled = true;
    elements.btnLoadSample.textContent = 'Loading Samples...';

    const data = await fetchJson('/api/seed-samples', { method: 'POST' });
    showToast(data.message || 'Sample reports loaded into database.');

    // Auto trigger analysis
    const analyzeData = await fetchJson('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (analyzeData.job_id) {
      startJobPolling(analyzeData.job_id, analyzeData.total);
    } else {
      loadDashboard();
      loadReports();
    }
  } catch (err) {
    console.error(err);
    showToast(`Error: ${err.message}`);
  } finally {
    elements.btnLoadSample.disabled = false;
    elements.btnLoadSample.textContent = 'Load OIL Sample Batch (8 Reports)';
  }
});

function closeModal() {
  if (elements.modalBackdrop) {
    elements.modalBackdrop.style.display = 'none';
  }
  state.activeReportId = null;
}

// Reset / Clear Database
elements.btnClearAll.addEventListener('click', async () => {
  try {
    elements.btnClearAll.disabled = true;
    elements.btnClearAll.textContent = 'Resetting...';

    // 1. Immediately cancel active frontend polling & reset progress
    if (state.pollInterval) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
    }
    state.activeJobId = null;
    if (elements.progressSection) {
      elements.progressSection.style.display = 'none';
      elements.progressBarFill.style.width = '0%';
      elements.progressCounter.textContent = '0 of 0 reports analyzed';
    }

    // 2. Clear staged upload files
    state.stagedFiles = [];
    if (typeof updateStagedFilesUI === 'function') {
      updateStagedFilesUI();
    }

    // 3. Close modal if open
    closeModal();

    // 4. Send reset request to backend
    console.log('[Frontend] Sending reset request to /api/reset...');
    let data;
    try {
      data = await fetchJson('/api/reset', { method: 'POST' });
    } catch (resetErr) {
      console.warn('Fallback to /api/clear:', resetErr);
      data = await fetchJson('/api/clear', { method: 'POST' });
    }
    console.log('[Frontend] Reset response:', data);
    showToast(data.message || 'Database successfully reset to zero state.');

    // 5. Force fresh fetch of dashboard and reports to guarantee genuine zero state
    await loadDashboard();
    await loadReports();
  } catch (err) {
    console.error('Reset error:', err);
    showToast(`Failed to reset database: ${err.message}`);
  } finally {
    elements.btnClearAll.disabled = false;
    elements.btnClearAll.textContent = 'Reset Database';
  }
});

// Asynchronous Job Polling
function startJobPolling(jobId, totalCount) {
  state.activeJobId = jobId;
  elements.progressSection.style.display = 'block';
  elements.progressBarFill.style.width = '0%';
  elements.progressCounter.textContent = `0 of ${totalCount} reports analyzed`;
  elements.progressBadge.textContent = 'Processing Batch';

  if (state.pollInterval) clearInterval(state.pollInterval);

  state.pollInterval = setInterval(async () => {
    // If active job changed or cancelled externally, abort polling
    if (state.activeJobId !== jobId) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
      return;
    }

    try {
      const job = await fetchJson(`/api/jobs/${jobId}`);

      // Handle aborted/cancelled jobs or missing job records
      if (!job || job.status === 'cancelled') {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
        elements.progressSection.style.display = 'none';
        return;
      }

      const total = job.total_reports || totalCount || 1;
      const completed = job.completed_reports || 0;
      const pct = Math.min(100, Math.round((completed / total) * 100));

      elements.progressBarFill.style.width = `${pct}%`;
      elements.progressCounter.textContent = `${completed} of ${total} reports analyzed (${pct}%)`;
      elements.progressCurrentFile.textContent = job.current_file || 'Processing...';
      elements.progressCurrentStep.textContent = job.current_step || 'Analyzing safety factors';

      if (job.status === 'completed') {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
        elements.progressBadge.textContent = 'Complete';
        elements.progressBarFill.style.width = '100%';
        elements.lastAnalysisTime.textContent = new Date().toLocaleTimeString();
        showToast('Batch safety analysis completed successfully.');

        setTimeout(() => {
          elements.progressSection.style.display = 'none';
        }, 1800);

        loadDashboard();
        loadReports();
      } else if (job.status === 'failed') {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
        elements.progressBadge.textContent = 'Failed';
        showToast('Batch analysis failed.');
      }
    } catch (err) {
      console.error('Job poll error:', err);
      // If 404 (database was reset and job deleted), stop polling cleanly
      if (err.message && (err.message.includes('404') || err.message.includes('not found'))) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
        elements.progressSection.style.display = 'none';
      }
    }
  }, 750);
}

// Fetch & Render Dashboard Analytics
async function loadDashboard() {
  try {
    const data = await fetchJson('/api/dashboard');

    // Summary numbers
    elements.metricTotal.textContent = data.total_reports || 0;
    elements.metricSif.textContent = data.sif_reports || 0;
    elements.metricCritical.textContent = data.critical || 0;
    elements.metricHigh.textContent = data.high || 0;
    elements.metricMedium.textContent = data.medium || 0;
    elements.metricLow.textContent = data.low || 0;

    // Filter tab counts
    const countAllEl = document.getElementById('tab-count-all');
    if (countAllEl) countAllEl.textContent = data.total_reports || 0;
    const countCritEl = document.getElementById('tab-count-critical');
    if (countCritEl) countCritEl.textContent = data.critical || 0;
    const countHighEl = document.getElementById('tab-count-high');
    if (countHighEl) countHighEl.textContent = data.high || 0;
    const countMedEl = document.getElementById('tab-count-medium');
    if (countMedEl) countMedEl.textContent = data.medium || 0;
    const countLowEl = document.getElementById('tab-count-low');
    if (countLowEl) countLowEl.textContent = data.low || 0;

    // Classification Bars
    const total = data.total_reports || 1;
    if (data.reports_by_type && data.reports_by_type.length > 0) {
      elements.typeBars.innerHTML = data.reports_by_type.map(item => {
        const typeName = item.report_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const pct = Math.round((item.count / total) * 100);
        return `
          <div class="type-bar-row">
            <span class="type-bar-label">${typeName}</span>
            <div class="type-bar-track">
              <div class="type-bar-fill" style="width: ${pct}%;"></div>
            </div>
            <span class="type-bar-count">${item.count}</span>
          </div>
        `;
      }).join('');
    } else {
      elements.typeBars.innerHTML = '<p class="text-secondary text-sm">No reports analyzed yet.</p>';
    }

    // Top Hazards List
    if (data.top_hazards && data.top_hazards.length > 0) {
      elements.hazardList.innerHTML = data.top_hazards.map(h => `
        <div class="hazard-item">
          <span class="hazard-name">${h.factor_name}</span>
          <span class="hazard-count">${h.count} flagged</span>
        </div>
      `).join('');
    } else {
      elements.hazardList.innerHTML = '<p class="text-secondary text-sm">No hazards flagged yet.</p>';
    }

  } catch (err) {
    console.error('Error loading dashboard metrics:', err);
  }
}

// Fetch & Render Prioritization Table
async function loadReports() {
  try {
    const params = new URLSearchParams();
    if (state.activeFilter && state.activeFilter !== 'all') {
      params.append('filter_by', state.activeFilter);
    }
    if (state.searchQuery) {
      params.append('search', state.searchQuery);
    }
    params.append('sort_by', state.sortBy);

    const data = await fetchJson(`/api/reports?${params.toString()}`);
    state.reports = data.reports || [];

    renderReportsTable(state.reports);
    updateTabCounts();
  } catch (err) {
    console.error('Error loading reports:', err);
  }
}

function updateTabCounts() {
  if (state.activeFilter !== 'all' || state.searchQuery) return;
  const allCount = state.reports.length;
  const critical = state.reports.filter(r => (r.risk_level || '').toUpperCase() === 'CRITICAL').length;
  const high = state.reports.filter(r => (r.risk_level || '').toUpperCase() === 'HIGH').length;
  const medium = state.reports.filter(r => (r.risk_level || '').toUpperCase() === 'MEDIUM').length;
  const low = state.reports.filter(r => (r.risk_level || '').toUpperCase() === 'LOW').length;

  const countAllEl = document.getElementById('tab-count-all');
  if (countAllEl) countAllEl.textContent = allCount;
  const countCritEl = document.getElementById('tab-count-critical');
  if (countCritEl) countCritEl.textContent = critical;
  const countHighEl = document.getElementById('tab-count-high');
  if (countHighEl) countHighEl.textContent = high;
  const countMedEl = document.getElementById('tab-count-medium');
  if (countMedEl) countMedEl.textContent = medium;
  const countLowEl = document.getElementById('tab-count-low');
  if (countLowEl) countLowEl.textContent = low;
}

function renderReportsTable(reports) {
  if (!reports || reports.length === 0) {
    const isFilterOrSearch = (state.activeFilter && state.activeFilter !== 'all') || Boolean(state.searchQuery);
    elements.reportsTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">
          <div class="empty-state-inner">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.6">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <p class="empty-title">${isFilterOrSearch ? 'No reports match current criteria' : 'No reports to display'}</p>
            <p class="empty-desc">${isFilterOrSearch ? 'Try clearing search terms or selecting another filter tab.' : 'Upload and analyze safety reports to see results here.'}</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  elements.reportsTableBody.innerHTML = reports.map((r, index) => {
    const riskLevel = (r.risk_level || 'LOW').toUpperCase();
    const sifStatus = (r.sif_detected || 'NO').toUpperCase();
    const rank = r.priority_rank || (index + 1);

    // Badges classes
    let riskBadgeClass = 'badge-low';
    if (riskLevel === 'CRITICAL') riskBadgeClass = 'badge-critical';
    else if (riskLevel === 'HIGH') riskBadgeClass = 'badge-high';
    else if (riskLevel === 'MEDIUM') riskBadgeClass = 'badge-medium';

    let sifBadgeClass = 'badge-sif-no';
    if (sifStatus === 'YES') sifBadgeClass = 'badge-sif-yes';
    else if (sifStatus === 'REVIEW REQUIRED') sifBadgeClass = 'badge-sif-review';

    // Type label
    const typeLabel = (r.report_type || 'Near Miss').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Factors tags
    const factors = r.key_factors || [];
    const factorTags = factors.slice(0, 2).map(f => `<span class="factor-tag">${f}</span>`).join('') +
      (factors.length > 2 ? `<span class="factor-tag">+${factors.length - 2} more</span>` : '');

    // Review status styling
    const revStatus = r.review_status || 'Pending Review';
    let revClass = 'text-muted';
    if (revStatus === 'Confirmed') revClass = 'text-critical font-bold';
    else if (revStatus === 'Requires Further Review') revClass = 'text-medium font-semibold';

    return `
      <tr data-report-id="${r.id}">
        <td>
          <span class="rank-badge ${rank === 1 ? 'rank-critical' : ''}">#${rank}</span>
        </td>
        <td>
          <div class="file-cell">
            <span class="file-name" onclick="openReportDetail(${r.id})">${r.filename}</span>
            <span class="file-meta font-mono">${r.location || 'Wellsite Asset'}</span>
          </div>
        </td>
        <td>
          <span class="badge badge-type">${typeLabel}</span>
        </td>
        <td>
          <span class="badge ${riskBadgeClass}">${riskLevel}</span>
        </td>
        <td>
          <span class="badge ${sifBadgeClass}">${sifStatus}</span>
        </td>
        <td>
          <div class="factor-tags">
            ${factorTags || '<span class="text-muted text-xs">Standard operational</span>'}
          </div>
        </td>
        <td>
          <span class="text-xs ${revClass}">${revStatus}</span>
        </td>
        <td style="text-align: right;">
          <button type="button" class="btn btn-outline btn-sm" onclick="openReportDetail(${r.id})">
            Review Details
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Open Report Details Modal
window.openReportDetail = async function(reportId) {
  try {
    state.activeReportId = reportId;
    elements.modalReportTitle.textContent = 'Loading Report...';
    elements.modalReportText.textContent = 'Fetching report narrative and factor analysis...';
    elements.modalBackdrop.style.display = 'flex';

    const data = await fetchJson(`/api/reports/${reportId}`);

    const rep = data.report;
    const ana = data.analysis || {};
    const factors = data.factors || [];
    const rev = data.review || {};

    // Header & Meta
    elements.modalReportTitle.textContent = rep.filename;
    elements.modalMetaFilename.textContent = rep.filename;
    elements.modalMetaType.textContent = (rep.report_type || 'Unspecified').replace(/_/g, ' ').toUpperCase();
    elements.modalMetaLocation.textContent = rep.location || 'Oil India Operational Field';
    elements.modalMetaDate.textContent = rep.uploaded_at ? new Date(rep.uploaded_at).toLocaleDateString() : 'Current Shift';
    elements.modalReportText.textContent = rep.report_text || 'No text extracted.';

    // Risk and SIF Badges
    const riskLevel = (ana.risk_level || 'LOW').toUpperCase();
    const score = ana.risk_score !== undefined ? ana.risk_score : 15;
    const sifStatus = (ana.sif_detected || 'NO').toUpperCase();
    const rank = ana.priority_rank || 1;

    elements.modalRiskBadge.textContent = riskLevel;
    elements.modalRiskBadge.className = `badge badge-lg ${
      riskLevel === 'CRITICAL' ? 'badge-critical' :
      riskLevel === 'HIGH' ? 'badge-high' :
      riskLevel === 'MEDIUM' ? 'badge-medium' : 'badge-low'
    }`;

    elements.modalRiskScore.textContent = score;
    elements.modalSifBadge.textContent = sifStatus;
    elements.modalSifBadge.className = `badge badge-lg ${
      sifStatus === 'YES' ? 'badge-sif-yes' :
      sifStatus === 'REVIEW REQUIRED' ? 'badge-sif-review' : 'badge-sif-no'
    }`;

    elements.modalPriorityRank.textContent = `#${rank} in Prioritized Batch`;

    // Explainability
    elements.modalExplanation.textContent = ana.explanation ||
      'Routine operational report with standard controls verified. No compounding precursors identified.';

    // Factors Grid
    if (factors.length > 0) {
      elements.modalFactorsGrid.innerHTML = factors.map(f => `
        <div class="factor-card">
          <div class="factor-card-type">${(f.factor_type || 'Factor').replace(/_/g, ' ')}</div>
          <div class="factor-card-name">${f.factor_name}</div>
          <div class="factor-card-evidence">"${f.evidence || 'Identified in report text'}"</div>
        </div>
      `).join('');
    } else {
      elements.modalFactorsGrid.innerHTML = '<p class="text-muted text-xs">No specific critical factors isolated.</p>';
    }

    // AI Suggestions
    let suggestions = [];
    if (ana.suggested_actions) {
      suggestions = ana.suggested_actions.split('\n').filter(s => s.trim().length > 0);
    }
    if (suggestions.length === 0) {
      suggestions = [
        "Audit existing Permit-to-Work documentation against field execution.",
        "Review barrier isolation standards during pre-shift safety toolbox talk.",
        "Log incident in OIL HSE compliance tracking system."
      ];
    }
    elements.modalSuggestionsList.innerHTML = suggestions.map(s => `<li>${s}</li>`).join('');

    // Review Form populate
    elements.reviewStatus.value = rev.status || 'Pending Review';
    elements.reviewerName.value = rev.reviewer || 'HSE Safety Officer';
    elements.reviewComment.value = rev.comment || '';
    elements.modalReviewedStamp.textContent = rev.reviewed_at 
      ? `Last recorded: ${new Date(rev.reviewed_at).toLocaleString()} by ${rev.reviewer || 'Safety Team'}`
      : 'Status: Awaiting human review determination';

  } catch (err) {
    console.error(err);
    showToast(`Failed to load details: ${err.message}`);
  }
};

// Close Modal
elements.modalCloseBtn.addEventListener('click', () => {
  elements.modalBackdrop.style.display = 'none';
  state.activeReportId = null;
});

elements.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === elements.modalBackdrop) {
    elements.modalBackdrop.style.display = 'none';
    state.activeReportId = null;
  }
});

// Human Review Submission
elements.reviewForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.activeReportId) return;

  try {
    const payload = {
      status: elements.reviewStatus.value,
      reviewer: elements.reviewerName.value,
      comment: elements.reviewComment.value
    };

    await fetchJson(`/api/reports/${state.activeReportId}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    showToast(`Human safety review decision recorded: ${payload.status}`);
    elements.modalReviewedStamp.textContent = `Recorded just now by ${payload.reviewer}`;

    // Refresh table and dashboard
    loadReports();
    loadDashboard();
  } catch (err) {
    console.error(err);
    showToast(`Error: ${err.message}`);
  }
});

// Filter Tabs Click
elements.filterBar.addEventListener('click', (e) => {
  const tab = e.target.closest('.filter-tab');
  if (!tab) return;

  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');

  state.activeFilter = tab.dataset.filter || 'all';
  loadReports();
});

// Search & Sort Event Listeners
let searchDebounce = null;
elements.tableSearch.addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = e.target.value.trim();
    loadReports();
  }, 250);
});

elements.tableSort.addEventListener('change', (e) => {
  state.sortBy = e.target.value;
  loadReports();
});

// Health check and initialization with automatic retry
async function checkHealth(retryCount = 0) {
  try {
    const data = await fetchJson('/api/health');
    if (data && data.status === 'healthy') {
      elements.systemStatusText.textContent = 'System Ready';
    } else {
      elements.systemStatusText.textContent = 'Service Degraded';
    }
  } catch {
    elements.systemStatusText.textContent = 'Connecting...';
    if (retryCount < 5) {
      setTimeout(() => checkHealth(retryCount + 1), 1000);
    } else {
      elements.systemStatusText.textContent = 'Offline';
    }
  }
}

// Initial Boot
document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  loadDashboard();
  loadReports();
});
