const view = name => {
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  document.getElementById(`view-${name}`).classList.remove('hidden');
}
document.querySelectorAll('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{
  view(btn.dataset.view);
}));
document.getElementById('btnNew').onclick=()=>view('create');

// List & filters
async function loadTable() {
  const u = document.getElementById('fUsuario').value;
  const e = document.getElementById('fEstado').value;
  const res = await fetch(`/api/reports?usuario=${encodeURIComponent(u)}&estado=${encodeURIComponent(e)}`);
  const data = await res.json();
  const tbody = document.querySelector('#tabla tbody');
  tbody.innerHTML = data.map(r=>`<tr>
    <td>${r.num_reporte}</td>
    <td>${r.cliente||''}</td>
    <td>${r.usuario||''}</td>
    <td>${r.tipo_servicio||''}</td>
    <td>${r.estado||''}</td>
    <td>${new Date(r.created_at).toLocaleString()}</td>
    <td>
      <a class="mini" href="${r.pdf_path}" target="_blank">PDF</a>
      <a class="mini" href="/public/report.html?id=${r.id}" target="_blank">Ver</a>
    </td>
  </tr>`).join('');
}
document.getElementById('btnFiltrar').onclick=loadTable;
loadTable();

// Form: signatures
function setupCanvas(id) {
  const c = document.getElementById(id);
  const ctx = c.getContext('2d');
  let drawing = false;
  const start = e => { drawing = true; ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); };
  const move = e => { if(!drawing) return; ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke(); };
  const end = ()=> drawing = false;
  c.addEventListener('mousedown', start);
  c.addEventListener('mousemove', move);
  c.addEventListener('mouseup', end);
  c.addEventListener('mouseleave', end);
  // touch
  c.addEventListener('touchstart', e=>{ e.preventDefault(); const r=c.getBoundingClientRect(); const t=e.touches[0]; start({offsetX:t.clientX-r.left, offsetY:t.clientY-r.top}); });
  c.addEventListener('touchmove', e=>{ e.preventDefault(); const r=c.getBoundingClientRect(); const t=e.touches[0]; move({offsetX:t.clientX-r.left, offsetY:t.clientY-r.top}); });
  c.addEventListener('touchend', e=>{ e.preventDefault(); end(); });
}
setupCanvas('sigTec');
setupCanvas('sigCli');
window.clearCanvas = (id)=>{
  const c=document.getElementById(id);
  c.getContext('2d').clearRect(0,0,c.width,c.height);
};

// Set now
document.getElementById('fechaNow').value = new Date().toLocaleString();

// Submit
document.getElementById('formReporte').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  fd.append('estado', 'ENVIADO');
  fd.append('firma_tecnico', document.getElementById('sigTec').toDataURL());
  fd.append('firma_cliente', document.getElementById('sigCli').toDataURL());

  const res = await fetch('/api/reports', { method:'POST', body: fd });
  const out = await res.json();
  if (out.ok) {
    document.getElementById('cTitle').textContent = `Reporte ${form.num_reporte.value} enviado con éxito.`;
    document.getElementById('btnPDF').href = out.pdf_url;
    document.getElementById('btnView').href = out.view_url;
    document.getElementById('btnWhats').href = `https://wa.me/?text=${encodeURIComponent(out.pdf_url + '\n' + out.view_url)}`;
    document.getElementById('confirm').classList.remove('hidden');
    form.classList.add('hidden');
  } else {
    alert('Error enviando: ' + out.error);
  }
});

document.getElementById('btnBorrador').addEventListener('click', async ()=>{
  const form = document.getElementById('formReporte');
  const fd = new FormData(form);
  fd.append('estado', 'PENDIENTE');
  fd.append('firma_tecnico', document.getElementById('sigTec').toDataURL());
  fd.append('firma_cliente', document.getElementById('sigCli').toDataURL());
  const res = await fetch('/api/reports', { method:'POST', body: fd });
  const out = await res.json();
  if (out.ok) {
    alert('Borrador guardado. Te llegará un correo de aviso (si el SMTP está configurado).');
    view('list'); loadTable();
  } else {
    alert('Error: ' + out.error);
  }
});

window.resetForm = ()=>{ location.reload(); };

// Stats
async function loadStats() {
  const res = await fetch('/api/stats');
  const s = await res.json();
  // por tipo
  const ctx1 = document.getElementById('chartTipo');
  new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: s.porTipo.map(x=>x.tipo_servicio || 'N/D'),
      datasets: [{ label: 'Servicios por tipo', data: s.porTipo.map(x=>x.total) }]
    }
  });
  // por usuario
  const ctx2 = document.getElementById('chartUsuario');
  new Chart(ctx2, {
    type: 'pie',
    data: {
      labels: s.porUsuario.map(x=>x.usuario || 'N/D'),
      datasets: [{ data: s.porUsuario.map(x=>x.total) }]
    }
  });
}
document.querySelector('button[data-view="stats"]')?.addEventListener('click', loadStats);
