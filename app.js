const inspectionData = [
  {
    "id": 5,
    "product": "API网关",
    "collectionMode": "web",
    "hasWebChart": "yes",
    "cpuSeries": [
      21.4,
      22.1,
      20.8,
      23.5,
      24.0,
      22.7,
      23.1
    ],
    "memSeries": [
      55.2,
      56.0,
      55.8,
      57.1,
      58.3,
      57.6,
      58.0
    ],
    "diskSeries": [
      61.0,
      61.0,
      61.2,
      61.2,
      61.3,
      61.3,
      61.4
    ],
    "cpuPeakSeries": [
      38.2,
      40.1,
      37.5,
      42.0,
      44.3,
      41.2,
      43.0
    ],
    "memPeakSeries": [
      57.0,
      58.1,
      57.4,
      59.2,
      60.5,
      59.0,
      60.1
    ],
    "diskPeakSeries": [
      61.2,
      61.2,
      61.4,
      61.4,
      61.5,
      61.5,
      61.6
    ],
    "productVersion": "V1.0R00C00",
    "remarks": "示例：有 7 天历史接口的设备，曲线为日均值、峰值为 7 天中各日峰值的最大值。"
  },
  {
    "id": 6,
    "product": "漏扫",
    "collectionMode": "web",
    "hasWebChart": "yes",
    "cpuSeries": [
      12.5
    ],
    "memSeries": [
      76.5
    ],
    "diskSeries": [
      66.0
    ],
    "cpuPeakSeries": [
      12.5
    ],
    "memPeakSeries": [
      76.5
    ],
    "diskPeakSeries": [
      66.0
    ],
    "productVersion": "V2.0R11C22",
    "remarks": "示例：只提供实时快照的设备，单点序列，峰值等于当前值。"
  },
  {
    "id": 7,
    "product": "态势感知",
    "collectionMode": "web",
    "hasWebChart": "no",
    "cpuSeries": null,
    "memSeries": null,
    "diskSeries": null,
    "productVersion": "",
    "remarks": "示例：页面不暴露资源接口的设备，资源列留空（显示 —），其余列照常。"
  }
];

function average(series) {
  const total = series.reduce((sum, value) => sum + value, 0);
  return Math.round((total / series.length) * 10) / 10;
}

// 资源峰值系列(cpuPeakSeries/diskPeakSeries/memPeakSeries)的7天平均; 无峰值数据返回 null
function peakAverage(item, resource) {
  const series = item[resource + 'PeakSeries'];
  if (!series || !series.length) return null;
  const total = series.reduce((sum, value) => sum + value, 0);
  return Math.round((total / series.length) * 10) / 10;
}

// 格式化峰值单元格: 无数据时显示 —
function fmtPeak(value) {
  return value === null ? '—' : value + '%';
}

function getStatus(cpu, disk, mem) {
  if (cpu >= 85 || disk >= 86 || mem >= 88) {
    return { text: '告警', className: 'status-danger' };
  }

  if (cpu >= 75 || disk >= 75 || mem >= 75) {
    return { text: '提醒', className: 'status-warning' };
  }

  return { text: '正常', className: 'status-ok' };
}

function drawOverview(values) {
  const avgCpu = average(values.map(item => average(item.cpuSeries)));
  const avgMem = average(values.map(item => average(item.memSeries)));
  const avgDisk = average(values.map(item => average(item.diskSeries)));

  document.getElementById('productCount').textContent = values.length;

  const warningCount = values.filter((item) => {
    const cpu = average(item.cpuSeries);
    const disk = average(item.diskSeries);
    const mem = average(item.memSeries);
    return cpu >= 80 || disk >= 80 || mem >= 80;
  }).length;

  document.getElementById('warnCount').textContent = String(warningCount);
  document.getElementById('avgCpu').textContent = avgCpu + '%';
  document.getElementById('avgDisk').textContent = avgDisk + '%';
  document.getElementById('avgMem').textContent = avgMem + '%';

  const trend = values.reduce((acc, item) => {
    acc.cpu.push(average(item.cpuSeries));
    acc.disk.push(average(item.diskSeries));
    acc.mem.push(average(item.memSeries));
    acc.cpuPeak.push(peakAverage(item, 'cpu'));
    acc.diskPeak.push(peakAverage(item, 'disk'));
    acc.memPeak.push(peakAverage(item, 'mem'));
    return acc;
  }, { cpu: [], disk: [], mem: [], cpuPeak: [], diskPeak: [], memPeak: [] });

  drawTrendChart(trend);
}

function renderProductBreakdown() {
  const container = document.getElementById('productBreakdown');
  container.innerHTML = '';

  inspectionData.forEach((item) => {
    const cpu = average(item.cpuSeries);
    const cpuPeak = peakAverage(item, 'cpu');
    const disk = average(item.diskSeries);
    const diskPeak = peakAverage(item, 'disk');
    const mem = average(item.memSeries);
    const memPeak = peakAverage(item, 'mem');

    const pill = (label, mean, peak) => `
      <span class="metric-pill">${label} <strong>${mean}%</strong>
        <span class="metric-sub">峰值 ${peak === null ? '—' : peak + '%'}</span>
      </span>`;

    const card = document.createElement('article');
    card.className = 'product-breakdown-card';
    card.innerHTML = `
      <div class="title">${item.product}</div>
      <div class="metrics">
        ${pill('CPU', cpu, cpuPeak)}
        ${pill('硬盘', disk, diskPeak)}
        ${pill('内存', mem, memPeak)}
      </div>
    `;
    container.appendChild(card);
  });
}

function renderTable() {
  const tableBody = document.getElementById('tableBody');
  tableBody.innerHTML = '';

  inspectionData.forEach((item) => {
    const cpu = average(item.cpuSeries);
    const cpuPeak = peakAverage(item, 'cpu');
    const disk = average(item.diskSeries);
    const diskPeak = peakAverage(item, 'disk');
    const mem = average(item.memSeries);
    const memPeak = peakAverage(item, 'mem');

    const status = getStatus(cpu, disk, mem);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="product-name">${item.product}</span></td>
      <td>${getCollectionLabel(item.collectionMode, item.hasWebChart)}</td>
      <td>${cpu}%</td>
      <td>${fmtPeak(cpuPeak)}</td>
      <td>${disk}%</td>
      <td>${fmtPeak(diskPeak)}</td>
      <td>${mem}%</td>
      <td>${fmtPeak(memPeak)}</td>
      <td><span class="status-badge ${status.className}">${status.text}</span></td>
      <td>${item.remarks || '--'}</td>
      <td class="table-actions">
        <button data-action="edit" data-id="${item.id}">编辑</button>
        <button data-action="detail" data-id="${item.id}">详情</button>
      </td>
    `;

    tableBody.appendChild(tr);
  });

  const alertList = document.getElementById('alertList');
  alertList.innerHTML = '';

  inspectionData.filter((item) => {
    const cpu = average(item.cpuSeries);
    const disk = average(item.diskSeries);
    const mem = average(item.memSeries);
    return cpu >= 75 || disk >= 75 || mem >= 75;
  }).forEach((item) => {
    const cpu = average(item.cpuSeries);
    const disk = average(item.diskSeries);
    const mem = average(item.memSeries);

    const alertDiv = document.createElement('div');
    alertDiv.className = `alert-item ${cpu >= 80 || disk >= 80 || mem >= 80 ? 'danger' : 'warn'}`;
    const cpuPeak = peakAverage(item, 'cpu');
    const diskPeak = peakAverage(item, 'disk');
    const memPeak = peakAverage(item, 'mem');

    alertDiv.innerHTML = `
      <div class="title">${item.product}</div>
      <div class="detail">CPU ${cpu}% / ${fmtPeak(cpuPeak)}（均/峰） · 硬盘 ${disk}% / ${fmtPeak(diskPeak)}（均/峰） · 内存 ${mem}% / ${fmtPeak(memPeak)}（均/峰）</div>
    `;
    alertList.appendChild(alertDiv);
  });
}

function getCollectionLabel(mode, hasWebChart) {
  if (mode === 'web') {
    return `Web界面${hasWebChart === 'yes' ? '（图形）' : '（无图形）'}`;
  }

  if (mode === 'bastion') {
    return '堡垒机后台';
  }

  return '手工表格';
}

function drawTrendChart(trend) {
  const canvas = document.getElementById('trendChart');
  const ctx = canvas.getContext('2d');

  const width = canvas.width || canvas.getBoundingClientRect().width || 640;
  const height = canvas.height || canvas.getBoundingClientRect().height || 200;

  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#faffff';
  ctx.fillRect(0, 0, width, height);

  const padding = { left: 32, top: 24, right: 12, bottom: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const maxY = 100;
  const valueToY = (value) => padding.top + plotHeight - (value / maxY) * plotHeight;

  const plotX = (index) => padding.left + (plotWidth / 6) * index;

  const colorMap = {
    cpu: '#2d78d8',
    disk: '#2e9a73',
    mem: '#e3a84b'
  };

  const lines = [
    { key: 'cpu', label: 'CPU', series: trend.cpu },
    { key: 'disk', label: '硬盘', series: trend.disk },
    { key: 'mem', label: '内存', series: trend.mem }
  ];

  // 峰值曲线（虚线）, 无峰值数据的点跳过
  const peakLines = [
    { key: 'cpuPeak', series: trend.cpuPeak },
    { key: 'diskPeak', series: trend.diskPeak },
    { key: 'memPeak', series: trend.memPeak }
  ];

  const drawSeries = (series, color, dashed) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.5 : 2;
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.beginPath();
    let started = false;
    series.forEach((value, index) => {
      if (value === null || value === undefined) return;
      const x = plotX(index);
      const y = valueToY(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    if (started) ctx.stroke();
    series.forEach((value, index) => {
      if (value === null || value === undefined) return;
      const x = plotX(index);
      const y = valueToY(value);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, dashed ? 2.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.setLineDash([]);
  };

  ctx.strokeStyle = '#a8c8dd';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.strokeStyle = '#dcecf2';
    ctx.stroke();
  }

  ctx.strokeStyle = '#7797a7';
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  lines.forEach((line) => drawSeries(line.series, colorMap[line.key], false));
  peakLines.forEach((line) => drawSeries(line.series, colorMap[line.key], true));
}

function exportReportCSV() {
  const headers = ['产品名称', '采集方式', 'CPU均值', 'CPU峰值', '硬盘均值', '硬盘峰值', '内存均值', '内存峰值', '当前状态', '说明'];
  const rows = inspectionData.map((item) => {
    const cpu = average(item.cpuSeries);
    const cpuPeak = peakAverage(item, 'cpu');
    const disk = average(item.diskSeries);
    const diskPeak = peakAverage(item, 'disk');
    const mem = average(item.memSeries);
    const memPeak = peakAverage(item, 'mem');
    const status = getStatus(cpu, disk, mem);

    return [
      item.product,
      getCollectionLabel(item.collectionMode, item.hasWebChart),
      cpu + '%',
      cpuPeak === null ? '' : cpuPeak + '%',
      disk + '%',
      diskPeak === null ? '' : diskPeak + '%',
      mem + '%',
      memPeak === null ? '' : memPeak + '%',
      status.text,
      item.remarks || ''
    ];
  });

  const csvContent = [headers, ...rows]
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'product-inspection-report.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function initTableEvents() {
  document.getElementById('tableBody').addEventListener('click', (event) => {
    const target = event.target;
    if (target.tagName !== 'BUTTON') return;

    const action = target.dataset.action;
    const productId = Number(target.dataset.id);
    const product = inspectionData.find((item) => item.id === productId);

    if (!product) return;

    if (action === 'edit') {
      document.getElementById('recordId').value = product.id;
      document.getElementById('productName').value = product.product;
      document.getElementById('collectionMode').value = product.collectionMode;
      document.getElementById('hasWebChart').value = product.hasWebChart;
      document.getElementById('cpuValue').value = average(product.cpuSeries);
      document.getElementById('diskValue').value = average(product.diskSeries);
      document.getElementById('memValue').value = average(product.memSeries);
      document.getElementById('cpuPeakValue').value = fmtPeak(peakAverage(product, 'cpu'));
      document.getElementById('diskPeakValue').value = fmtPeak(peakAverage(product, 'disk'));
      document.getElementById('memPeakValue').value = fmtPeak(peakAverage(product, 'mem'));
      document.getElementById('remarks').value = product.remarks;

      const newProductSection = document.getElementById('new-product');
      if (newProductSection) {
        newProductSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    if (action === 'detail') {
      const cpu = average(product.cpuSeries);
      const cpuPeak = peakAverage(product, 'cpu');
      const disk = average(product.diskSeries);
      const diskPeak = peakAverage(product, 'disk');
      const mem = average(product.memSeries);
      const memPeak = peakAverage(product, 'mem');
      alert(`${product.product}\nCPU均值: ${cpu}% / 峰值: ${fmtPeak(cpuPeak)}\n硬盘均值: ${disk}% / 峰值: ${fmtPeak(diskPeak)}\n内存均值: ${mem}% / 峰值: ${fmtPeak(memPeak)}\n采集方式: ${getCollectionLabel(product.collectionMode, product.hasWebChart)}`);
    }
  });
}

function initForm() {
  const form = document.getElementById('inspectionForm');
  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const id = Number(document.getElementById('recordId').value) || Date.now();
    const readPeak = (id) => {
      const raw = document.getElementById(id).value.trim();
      if (!raw || raw === '—') return null;
      const n = Number(raw);
      return isNaN(n) ? null : [n];
    };
    const product = {
      id,
      product: document.getElementById('productName').value.trim(),
      collectionMode: document.getElementById('collectionMode').value,
      hasWebChart: document.getElementById('hasWebChart').value,
      cpuSeries: [Number(document.getElementById('cpuValue').value)],
      diskSeries: [Number(document.getElementById('diskValue').value)],
      memSeries: [Number(document.getElementById('memValue').value)],
      cpuPeakSeries: readPeak('cpuPeakValue'),
      diskPeakSeries: readPeak('diskPeakValue'),
      memPeakSeries: readPeak('memPeakValue'),
      remarks: document.getElementById('remarks').value.trim() || '手工录入'
    };

    const index = inspectionData.findIndex((item) => item.id === id);
    if (index >= 0) {
      inspectionData[index] = product;
    } else {
      inspectionData.push(product);
    }

    renderTable();
    drawOverview(inspectionData);
    form.reset();
  });
}

function initNavLinks() {
  const navLinks = document.querySelectorAll('[href^="#"]');

  navLinks.forEach((link) => {
    link.addEventListener('click', (event) => {
      const selector = event.currentTarget.getAttribute('href');
      const target = document.querySelector(selector);

      if (target) {
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      document.querySelectorAll('.nav-link').forEach((item) => {
        item.classList.toggle('active', item === link);
      });
    });
  });
}

function initExportButton() {
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportReportCSV();
    });
  }
}

function init() {
  drawOverview(inspectionData);
  renderProductBreakdown();
  renderTable();
  initTableEvents();
  initForm();
  initNavLinks();
  initExportButton();
}

init();
