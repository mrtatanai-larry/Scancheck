class SubjectReportManager {
    normalizeStatus(status, percentage = 0) {
        const normalized = String(status || '').trim().toLowerCase();
        if (normalized === 'pass' || normalized === 'passinhon') return 'PASS';
        if (normalized === 'fail' || normalized === 'non-passinhon' || normalized === 'non passinhon') return 'FAIL';
        return Number(percentage) >= 75 ? 'PASS' : 'FAIL';
    }
    
    async loadSubjectReport() {
        try {
            const subjectCode = document.getElementById('reportSubjectSelect')?.value || '';
            const entryType = document.getElementById('reportEntrySelect')?.value || '';
            const equityGroup = document.getElementById('reportEquitySelect')?.value || '';
            const dateFrom = document.getElementById('reportDateFrom')?.value || '';
            const dateTo = document.getElementById('reportDateTo')?.value || '';
            const minScore = document.getElementById('reportMinScore')?.value || '';
            
            let params = [];
            if (subjectCode) params.push('subjectCode=' + encodeURIComponent(subjectCode));
            if (entryType) params.push('entryType=' + encodeURIComponent(entryType));
            if (equityGroup) params.push('equityGroup=' + encodeURIComponent(equityGroup));
            if (dateFrom) params.push('dateFrom=' + encodeURIComponent(dateFrom));
            if (dateTo) params.push('dateTo=' + encodeURIComponent(dateTo));
            if (minScore) params.push('minScore=' + encodeURIComponent(minScore));
            let url = '/api/reports/subjects';
            if (params.length > 0) url += '?' + params.join('&');
            
            const report = await scanCheckConfig.apiCall(url);
            
            if (!report) throw new Error('No report data received');
            
            this.renderSubjectReport(report);
        } catch (error) {
            console.error('Error loading subject report:', error);
            const container = document.getElementById('subjectReport');
            if (container) {
                container.innerHTML = '<div class="alert alert-danger">Error loading report: ' + error.message + '</div>';
            }
        }
    }

    renderSubjectReport(report) {
        const container = document.getElementById('subjectReport');
        if (!container) return;
        
        const records = report;
        
        if (!records || records.length === 0) {
            container.innerHTML = '<div class="alert alert-info text-center py-4">No subject records found for the selected filters.</div>';
            return;
        }

        const subjectRanking = this.buildSubjectRanking(records);
        const departmentRanking = this.buildDepartmentRanking(records);
        
        container.innerHTML = `
            <div class="card shadow-sm border-0">
                <div class="card-header bg-white py-3">
                    <h5 class="mb-0"><i class="fas fa-book me-2 text-primary"></i> Subject Performance Report</h5>
                </div>
                <div class="card-body">
                    <!-- Charts Section -->
                    <div class="row g-3 mb-4">
                        <div class="col-lg-6">
                            <div class="card h-100 border-0 shadow-sm">
                                <div class="card-header bg-light">
                                    <h6 class="mb-0 fw-bold"><i class="fas fa-chart-bar me-2 text-primary"></i> Subject Performance</h6>
                                </div>
                                <div class="card-body" style="height: 300px;">
                                    <canvas id="subjectChartReport"></canvas>
                                </div>
                            </div>
                        </div>
                        <div class="col-lg-6">
                            <div class="card h-100 border-0 shadow-sm">
                                <div class="card-header bg-light">
                                    <h6 class="mb-0 fw-bold"><i class="fas fa-chart-bar me-2 text-primary"></i> Department Performance</h6>
                                </div>
                                <div class="card-body" style="height: 300px;">
                                    <canvas id="departmentChartReport"></canvas>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Ranking Tables -->
                    <div class="row g-3 mb-4">
                        <div class="col-lg-6">
                            <div class="card h-100 border-0 shadow-sm">
                                <div class="card-header bg-light">
                                    <h6 class="mb-0 fw-bold"><i class="fas fa-ranking-star me-2 text-primary"></i>Subject Overall Ranking</h6>
                                </div>
                                <div class="table-responsive">
                                    <table class="table table-sm align-middle mb-0">
                                        <thead class="table-light">
                                            <tr>
                                                <th style="width: 56px;">Rank</th>
                                                <th>Subject</th>
                                                <th class="text-end">Avg %</th>
                                                <th class="text-end">Pass %</th>
                                                <th class="text-end">Takers</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${subjectRanking.map(row => `
                                                <tr>
                                                    <td><span class="badge bg-primary">${row.rank}</span></td>
                                                    <td><span class="badge bg-secondary me-1">${this.escapeHtml(row.subjectCode)}</span>${this.escapeHtml(row.subjectName)}</td>
                                                    <td class="text-end fw-bold">${row.averagePercentage.toFixed(1)}%</td>
                                                    <td class="text-end">${row.passRate.toFixed(1)}%</td>
                                                    <td class="text-end">${row.totalRecords}</td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                        <div class="col-lg-6">
                            <div class="card h-100 border-0 shadow-sm">
                                <div class="card-header bg-light">
                                    <h6 class="mb-0 fw-bold"><i class="fas fa-building me-2 text-primary"></i>Department Ranking</h6>
                                </div>
                                <div class="table-responsive">
                                    <table class="table table-sm align-middle mb-0">
                                        <thead class="table-light">
                                            <tr>
                                                <th style="width: 56px;">Rank</th>
                                                <th>Department</th>
                                                <th class="text-end">Avg %</th>
                                                <th class="text-end">Pass %</th>
                                                <th class="text-end">Takers</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${departmentRanking.map(row => `
                                                <tr>
                                                    <td><span class="badge bg-primary">${row.rank}</span></td>
                                                    <td class="fw-semibold">${this.escapeHtml(row.department)}</td>
                                                    <td class="text-end fw-bold">${row.averagePercentage.toFixed(1)}%</td>
                                                    <td class="text-end">${row.passRate.toFixed(1)}%</td>
                                                    <td class="text-end">${row.totalRecords}</td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Detailed Table -->
                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <h6 class="mb-0"><i class="fas fa-table me-2"></i>Detailed Records</h6>
                        <button class="btn btn-danger btn-sm" onclick="subjectReportManager.deleteAllRecords()">
                            <i class="fas fa-trash-alt me-1"></i> Delete All Records
                        </button>
                    </div>
                    <div class="table-responsive">
                        <table class="table table-hover align-middle">
                            <thead class="table-light">
                                <tr>
                                    <th>Student Name</th>
                                    <th>Entry / Equity</th>
                                    <th>Subject</th>
                                    <th>Score</th>
                                    <th>Percentage</th>
                                    <th>Status</th>
                                    <th>Date</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${records.map(record => `
                                    <tr id="record-${record.id}">
                                        <td class="fw-bold">${this.escapeHtml(record.student_name)}</td>
                                        <td>
                                            <div class="small">
                                                <span class="badge bg-info text-dark border me-1">${this.escapeHtml(record.entry_type || 'New Student')}</span>
                                                <span class="badge bg-warning text-dark border">${this.escapeHtml(record.special_equity_group || 'None')}</span>
                                            </div>
                                        </td>
                                        <td><span class="badge bg-secondary">${record.subject_code}</span> ${record.subject_name}</td>
                                        <td>${record.score} / ${record.total_questions}</td>
                                        <td>
                                            <div class="d-flex align-items-center">
                                                <div class="progress flex-grow-1 me-2" style="height: 6px;">
                                                    <div class="progress-bar ${record.percentage >= 70 ? 'bg-success' : 'bg-danger'}" 
                                                         role="progressbar" style="width: ${record.percentage}%"></div>
                                                </div>
                                                <span>${record.percentage}%</span>
                                            </div>
                                        </td>
                                        <td>
                                            <span class="badge bg-${this.normalizeStatus(record.status, record.percentage) === 'PASS' ? 'success' : 'danger'}">
                                                ${this.normalizeStatus(record.status, record.percentage)}
                                            </span>
                                        </td>
                                        <td class="text-muted small">${new Date(record.timestamp).toLocaleString()}</td>
                                        <td>
                                            <button class="btn btn-sm btn-outline-danger" onclick="subjectReportManager.deleteRecord(${record.id})" title="Delete this record">
                                                <i class="fas fa-trash-alt"></i>
                                            </button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        // Render charts after DOM is updated
        setTimeout(() => {
            this.renderCharts(subjectRanking, departmentRanking);
        }, 100);
    }

    renderCharts(subjectRanking, departmentRanking) {
        // Subject Chart
        const subjectCtx = document.getElementById('subjectChartReport');
        if (subjectCtx) {
            new Chart(subjectCtx, {
                type: 'bar',
                data: {
                    labels: subjectRanking.map(r => r.subjectCode),
                    datasets: [
                        {
                            label: 'Average Score (%)',
                            data: subjectRanking.map(r => r.averagePercentage),
                            backgroundColor: 'rgba(54, 162, 235, 0.7)',
                            borderColor: 'rgba(54, 162, 235, 1)',
                            borderWidth: 1
                        },
                        {
                            label: 'Pass Rate (%)',
                            data: subjectRanking.map(r => r.passRate),
                            backgroundColor: 'rgba(75, 192, 192, 0.7)',
                            borderColor: 'rgba(75, 192, 192, 1)',
                            borderWidth: 1
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom'
                        }
                    }
                }
            });
        }

        // Department Chart
        const departmentCtx = document.getElementById('departmentChartReport');
        if (departmentCtx) {
            new Chart(departmentCtx, {
                type: 'bar',
                data: {
                    labels: departmentRanking.map(r => r.department),
                    datasets: [
                        {
                            label: 'Average Score (%)',
                            data: departmentRanking.map(r => r.averagePercentage),
                            backgroundColor: 'rgba(255, 99, 132, 0.7)',
                            borderColor: 'rgba(255, 99, 132, 1)',
                            borderWidth: 1
                        },
                        {
                            label: 'Pass Rate (%)',
                            data: departmentRanking.map(r => r.passRate),
                            backgroundColor: 'rgba(153, 102, 255, 0.7)',
                            borderColor: 'rgba(153, 102, 255, 1)',
                            borderWidth: 1
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom'
                        }
                    }
                }
            });
        }
    }

    buildSubjectRanking(records) {
        const statsMap = new Map();
        records.forEach((record) => {
            const subjectCode = String(record.subject_code || 'N/A').trim() || 'N/A';
            const subjectName = String(record.subject_name || subjectCode).trim() || subjectCode;
            const percentage = Number.parseFloat(record.percentage) || 0;
            const passed = this.normalizeStatus(record.status, percentage) === 'PASS' ? 1 : 0;

            if (!statsMap.has(subjectCode)) {
                statsMap.set(subjectCode, {
                    subjectCode,
                    subjectName,
                    totalRecords: 0,
                    totalPercentage: 0,
                    passCount: 0
                });
            }
            const row = statsMap.get(subjectCode);
            row.totalRecords += 1;
            row.totalPercentage += percentage;
            row.passCount += passed;
        });

        const rows = Array.from(statsMap.values()).map((row) => ({
            ...row,
            averagePercentage: row.totalRecords ? (row.totalPercentage / row.totalRecords) : 0,
            passRate: row.totalRecords ? (row.passCount / row.totalRecords) * 100 : 0
        }));

        rows.sort((a, b) => {
            if (b.averagePercentage !== a.averagePercentage) return b.averagePercentage - a.averagePercentage;
            if (b.passRate !== a.passRate) return b.passRate - a.passRate;
            return b.totalRecords - a.totalRecords;
        });

        return rows.map((row, index) => ({ ...row, rank: index + 1 }));
    }

    buildDepartmentRanking(records) {
        const statsMap = new Map();
        records.forEach((record) => {
            const department = String(record.department_label || record.department || record.course || 'Unassigned').trim() || 'Unassigned';
            const percentage = Number.parseFloat(record.percentage) || 0;
            const passed = this.normalizeStatus(record.status, percentage) === 'PASS' ? 1 : 0;

            if (!statsMap.has(department)) {
                statsMap.set(department, {
                    department,
                    totalRecords: 0,
                    totalPercentage: 0,
                    passCount: 0
                });
            }
            const row = statsMap.get(department);
            row.totalRecords += 1;
            row.totalPercentage += percentage;
            row.passCount += passed;
        });

        const rows = Array.from(statsMap.values()).map((row) => ({
            ...row,
            averagePercentage: row.totalRecords ? (row.totalPercentage / row.totalRecords) : 0,
            passRate: row.totalRecords ? (row.passCount / row.totalRecords) * 100 : 0
        }));

        rows.sort((a, b) => {
            if (b.averagePercentage !== a.averagePercentage) return b.averagePercentage - a.averagePercentage;
            if (b.passRate !== a.passRate) return b.passRate - a.passRate;
            return b.totalRecords - a.totalRecords;
        });

        return rows.map((row, index) => ({ ...row, rank: index + 1 }));
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async deleteRecord(recordId) {
        if (!confirm('Are you sure you want to delete this record? This action cannot be undone.')) {
            return;
        }

        try {
            await scanCheckConfig.apiCall(`/api/subject-records/${recordId}`, {
                method: 'DELETE'
            });

            // Remove the row from the table
            const row = document.getElementById(`record-${recordId}`);
            if (row) {
                row.remove();
            }

            // Show success message
            alert('Record deleted successfully!');

            // Reload the report to update statistics
            await this.loadSubjectReport();
        } catch (error) {
            console.error('Error deleting record:', error);
            alert('Failed to delete record: ' + error.message);
        }
    }

    async deleteAllRecords() {
        const subjectCode = document.getElementById('reportSubjectSelect')?.value || '';
        const entryType = document.getElementById('reportEntrySelect')?.value || '';
        const equityGroup = document.getElementById('reportEquitySelect')?.value || '';
        const dateFrom = document.getElementById('reportDateFrom')?.value || '';
        const dateTo = document.getElementById('reportDateTo')?.value || '';

        let confirmMessage = 'Are you sure you want to delete ALL subject records';
        if (subjectCode || entryType || equityGroup || dateFrom || dateTo) {
            confirmMessage += ' matching the current filters';
        }
        confirmMessage += '? This action cannot be undone.';

        if (!confirm(confirmMessage)) {
            return;
        }

        // Double confirmation for safety
        if (!confirm('This will permanently delete all matching records. Are you absolutely sure?')) {
            return;
        }

        try {
            const params = new URLSearchParams({
                subjectCode: subjectCode || '',
                entryType: entryType || '',
                equityGroup: equityGroup || '',
                dateFrom: dateFrom || '',
                dateTo: dateTo || ''
            });

            await scanCheckConfig.apiCall(`/api/subject-records/bulk-delete?${params}`, {
                method: 'DELETE'
            });

            // Show success message
            alert('All matching records deleted successfully!');

            // Reload the report
            await this.loadSubjectReport();
        } catch (error) {
            console.error('Error deleting records:', error);
            alert('Failed to delete records: ' + error.message);
        }
    }
}

// Initialize subject report manager and make it global
window.subjectReportManager = new SubjectReportManager();

// Listen for hash changes to load report when on the reports page
window.addEventListener('hashchange', () => {
    if (window.location.hash === '#/reports') {
        window.subjectReportManager.loadSubjectReport();
    }
});
