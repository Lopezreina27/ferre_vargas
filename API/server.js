// --- server.js optimizado ---
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import sharp from 'sharp';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());
app.use(helmet());
app.use(compression());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MAIL_TO = process.env.MAIL_TO || 'soportetecnicosietmasseimsas@gmail.com';
const APP_NAME = process.env.APP_NAME || 'Reportes de Servicio – SEIM SAS';

// --------------------- DB INIT ---------------------
let db;
async function initDB() {
  db = await open({
    filename: path.join(__dirname, 'reports.db'),
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      updated_at TEXT,
      num_reporte TEXT,
      usuario TEXT,
      cliente TEXT,
      telefono TEXT,
      tipo_equipo TEXT,
      tipo_servicio TEXT,
      diagnostico TEXT,
      trabajos TEXT,
      observaciones TEXT,
      estado TEXT,
      firma_tecnico TEXT,
      firma_cliente TEXT,
      fotos TEXT,
      anexos TEXT,
      pdf_path TEXT
    );
  `);
}
await initDB();

// --------------------- MULTER CONFIG ---------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/\s+/g, '_');
    cb(null, `${Date.now()}_${name}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máx
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|pdf/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido'));
  }
});

// --------------------- HELPERS ---------------------
function saveBase64PNG(dataURL, outPath) {
  const base64 = dataURL.split(',')[1];
  fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
}

async function optimizeImage(inputPath) {
  try {
    const buffer = await sharp(inputPath).resize({ width: 1200 }).jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(inputPath, buffer);
  } catch (err) {
    console.error('Error optimizando imagen:', err.message);
  }
}

async function generatePDF(report) {
  const pdfDir = path.join(__dirname, 'uploads');
  const pdfFile = path.join(
    pdfDir,
    `Reporte_${report.num_reporte}_${report.usuario}_${report.created_at.split('T')[0]}.pdf`.replace(/\s+/g, '_')
  );

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const stream = fs.createWriteStream(pdfFile);
  doc.pipe(stream);

  // Header compacto
doc.fontSize(14).text(APP_NAME);
doc.moveDown(0.2).fontSize(10);

doc.text(`Reporte: ${report.num_reporte}    Fecha: ${new Date(report.created_at).toLocaleString()}`);
doc.text(`Usuario: ${report.usuario}`);
doc.text(`Teléfono: ${report.telefono}`);
doc.text(`Técnico / Lugar: ${report.cliente}`);


doc.moveDown(0.3).moveTo(40, doc.y).lineTo(555, doc.y).stroke();


  // Fields
  const field = (title, value) => {
    doc.moveDown(0.4).font('Helvetica-Bold').text(title);
    doc.font('Helvetica').text(value || '-', { align: 'justify' });
  };
  field('Tipo de equipo', report.tipo_equipo);
  field('Tipo de servicio', report.tipo_servicio);
  field('Diagnóstico', report.diagnostico);
  field('Trabajos realizados', report.trabajos);
  field('Observaciones', report.observaciones);

  // Fotos
  const fotos = JSON.parse(report.fotos || '[]');
  if (fotos.length) {
    doc.font('Helvetica-Bold').fontSize(12).text('Registro fotográfico').moveDown(0.3);
    let x = 40, y = doc.y, maxW = 180, maxH = 140;
    for (let foto of fotos) {
      try {
        doc.image(path.join(__dirname, foto), x, y, { fit: [maxW, maxH] });
      } catch (e) {}
      x += maxW + 15;
      if (x + maxW > 555) { x = 40; y += maxH + 20; }
      if (y + maxH > 740) { doc.addPage(); y = 60; }
    }
  }

  // Firmas
  doc.font('Helvetica-Bold').fontSize(12).text('Firmas').moveDown(0.3);
  const yStart = doc.y;
  if (report.firma_tecnico) {
    try { doc.image(path.join(__dirname, report.firma_tecnico), 60, yStart, { width: 180 }); } catch {}
    doc.fontSize(10).text('Técnico', 100, yStart + 90, { width: 80, align: 'center' });
  }
  if (report.firma_cliente) {
    try { doc.image(path.join(__dirname, report.firma_cliente), 320, yStart, { width: 180 }); } catch {}
    doc.fontSize(10).text('Cliente', 360, yStart + 90, { width: 80, align: 'center' });
  }

  // QR
  const publicReportURL = `${BASE_URL}/public/report.html?id=${report.id}`;
  const publicPDFURL = `${BASE_URL}${report.pdf_path ? report.pdf_path : '/uploads/' + path.basename(pdfFile)}`;
  const qrDataURL = await QRCode.toDataURL(`${publicReportURL}|${publicPDFURL}`, {
    color: { dark: '#00A650', light: '#FFFF00' },
    margin: 1,
    width: 160
  });
  const qrPath = path.join(__dirname, 'uploads', `qr_${report.id}.png`);
  saveBase64PNG(qrDataURL, qrPath);
  try {
   doc.fontSize(8).text('Escanee para ver el reporte y PDF online', 40, doc.page.height - 60);
doc.image(qrPath, doc.page.width - 150, doc.page.height - 100, { width: 90 });
  } catch {}

  doc.end();
  await new Promise(res => stream.on('finish', res));
  return '/uploads/' + path.basename(pdfFile);
}

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

// --------------------- ROUTES ---------------------
app.get('/api/health', (req, res) => res.json({ ok: true }));

const cpUpload = upload.fields([
  { name: 'fotos', maxCount: 10 },
  { name: 'anexos', maxCount: 10 }
]);

app.post(
  '/api/reports',
  cpUpload,
  [
    body('num_reporte').notEmpty().withMessage('Número de reporte requerido'),
    body('usuario').notEmpty().withMessage('Usuario requerido'),
    body('cliente').notEmpty().withMessage('Cliente requerido')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

      const id = uuidv4();
      const now = new Date().toISOString();
      const data = req.body;

      let firmaTecnicoPath = null, firmaClientePath = null;
      if (data.firma_tecnico) {
        firmaTecnicoPath = `/uploads/firma_tecnico_${id}.png`;
        saveBase64PNG(data.firma_tecnico, path.join(__dirname, firmaTecnicoPath));
      }
      if (data.firma_cliente) {
        firmaClientePath = `/uploads/firma_cliente_${id}.png`;
        saveBase64PNG(data.firma_cliente, path.join(__dirname, firmaClientePath));
      }

      const fotos = (req.files['fotos'] || []).map(f => {
        optimizeImage(f.path);
        return `/uploads/${path.basename(f.path)}`;
      });
      const anexos = (req.files['anexos'] || []).map(f => `/uploads/${path.basename(f.path)}`);

      await db.run(
        `INSERT INTO reports (
          id, created_at, updated_at, num_reporte, usuario, cliente, telefono,
          tipo_equipo, tipo_servicio, diagnostico, trabajos, observaciones, estado,
          firma_tecnico, firma_cliente, fotos, anexos, pdf_path
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, now, now, data.num_reporte, data.usuario, data.cliente, data.telefono,
          data.tipo_equipo, data.tipo_servicio, data.diagnostico, data.trabajos,
          data.observaciones, data.estado || 'ENVIADO',
          firmaTecnicoPath, firmaClientePath, JSON.stringify(fotos), JSON.stringify(anexos), null
        ]
      );

      const report = await db.get('SELECT * FROM reports WHERE id=?', [id]);
      const pdfPath = await generatePDF(report);
      await db.run('UPDATE reports SET pdf_path=?, updated_at=? WHERE id=?', [pdfPath, new Date().toISOString(), id]);

      const transporter = getTransporter();
      if (transporter) {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: MAIL_TO,
          subject: `Reporte ${report.num_reporte}_${report.usuario}_${report.created_at.slice(0, 10)}`,
          html: `<p>Nuevo reporte enviado.</p>
                 <p><a href="${BASE_URL}${pdfPath}">Descargar PDF</a></p>
                 <p><a href="${BASE_URL}/public/report.html?id=${id}">Ver reporte online</a></p>`,
          attachments: [{ filename: path.basename(pdfPath), path: path.join(__dirname, pdfPath) }]
        });
      }

      res.json({ ok: true, id, pdf_url: `${BASE_URL}${pdfPath}`, view_url: `${BASE_URL}/public/report.html?id=${id}` });
    } catch (e) {
      next(e);
    }
  }
);

app.get('/api/reports', async (req, res, next) => {
  try {
    const { usuario, estado, desde, hasta } = req.query;
    let where = [], params = [];
    if (usuario) { where.push('usuario=?'); params.push(usuario); }
    if (estado) { where.push('estado=?'); params.push(estado); }
    if (desde) { where.push('created_at>=?'); params.push(desde); }
    if (hasta) { where.push('created_at<=?'); params.push(hasta); }
    const sql = `SELECT * FROM reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    res.json(await db.all(sql, params));
  } catch (e) { next(e); }
});

app.get('/api/reports/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM reports WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ ok: false });
    res.json(row);
  } catch (e) { next(e); }
});

app.get('/api/stats', async (req, res, next) => {
  try {
    const rows = await db.all('SELECT tipo_servicio, COUNT(*) as total FROM reports GROUP BY tipo_servicio');
    const users = await db.all('SELECT usuario, COUNT(*) as total FROM reports GROUP BY usuario');
    res.json({ porTipo: rows, porUsuario: users });
  } catch (e) { next(e); }
});

app.get('/', (req, res) => res.redirect('/public/index.html'));

// --------------------- ERROR HANDLER ---------------------
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on ${PORT} - Base URL: ${BASE_URL}`);
});
