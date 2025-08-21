// --- server.js con Supabase (DB + Storage) ---
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import nodemailer from "nodemailer";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { body, validationResult } from "express-validator";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cors());
app.use(helmet());
app.use(compression());

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MAIL_TO = process.env.MAIL_TO || "soportetecnicosietmasseimsas@gmail.com";
const APP_NAME = process.env.APP_NAME || "Reportes de Servicio – SEIM SAS";

// --------------------- SUPABASE INIT ---------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// --------------------- MULTER CONFIG ---------------------
const storage = multer.memoryStorage(); // Guardamos en memoria y luego subimos a Supabase
const upload = multer({ storage });

// --------------------- HELPERS ---------------------
async function uploadToStorage(bucket, filePath, buffer, contentType) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(filePath, buffer, { contentType, upsert: true });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

function saveBase64ToBuffer(dataURL) {
  const base64 = dataURL.split(",")[1];
  return Buffer.from(base64, "base64");
}

async function generatePDF(report, fotos = [], firmas = {}) {
  const pdfName = `Reporte_${report.num_reporte}_${report.usuario}_${new Date()
    .toISOString()
    .slice(0, 10)}.pdf`.replace(/\s+/g, "_");

  const pdfPath = `pdfs/${report.id}/${pdfName}`;
  const doc = new PDFDocument({ margin: 40, size: "A4" });

  // Guardar PDF en buffer
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const endPromise = new Promise((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks)))
  );

  // Header
  doc.fontSize(14).text(APP_NAME);
  doc.moveDown(0.2).fontSize(10);
  doc.text(`Reporte: ${report.num_reporte}    Fecha: ${new Date(report.created_at).toLocaleString()}`);
  doc.text(`Usuario: ${report.usuario}`);
  doc.text(`Teléfono: ${report.telefono}`);
  doc.text(`Cliente: ${report.cliente}`);
  doc.moveDown(0.3).moveTo(40, doc.y).lineTo(555, doc.y).stroke();

  // Campos
  const field = (title, value) => {
    doc.moveDown(0.4).font("Helvetica-Bold").text(title);
    doc.font("Helvetica").text(value || "-", { align: "justify" });
  };
  field("Tipo de equipo", report.tipo_equipo);
  field("Tipo de servicio", report.tipo_servicio);
  field("Diagnóstico", report.diagnostico);
  field("Trabajos realizados", report.trabajos);
  field("Observaciones", report.observaciones);

  // Fotos
  if (fotos.length) {
    doc.font("Helvetica-Bold").fontSize(12).text("Registro fotográfico").moveDown(0.3);
    let x = 40, y = doc.y, maxW = 180, maxH = 140;
    for (let foto of fotos) {
      try {
        const imgBuffer = Buffer.from(await (await fetch(foto)).arrayBuffer());
        doc.image(imgBuffer, x, y, { fit: [maxW, maxH] });
      } catch {}
      x += maxW + 15;
      if (x + maxW > 555) { x = 40; y += maxH + 20; }
      if (y + maxH > 740) { doc.addPage(); y = 60; }
    }
  }

  // Firmas
  doc.font("Helvetica-Bold").fontSize(12).text("Firmas").moveDown(0.3);
  const yStart = doc.y;
  if (firmas.firma_tecnico) {
    try {
      const imgBuffer = Buffer.from(await (await fetch(firmas.firma_tecnico)).arrayBuffer());
      doc.image(imgBuffer, 60, yStart, { width: 180 });
    } catch {}
    doc.fontSize(10).text("Técnico", 100, yStart + 90, { width: 80, align: "center" });
  }
  if (firmas.firma_cliente) {
    try {
      const imgBuffer = Buffer.from(await (await fetch(firmas.firma_cliente)).arrayBuffer());
      doc.image(imgBuffer, 320, yStart, { width: 180 });
    } catch {}
    doc.fontSize(10).text("Cliente", 360, yStart + 90, { width: 80, align: "center" });
  }

  // QR
  const publicReportURL = `${BASE_URL}/public/report.html?id=${report.id}`;
  const publicPDFURL = `${BASE_URL}/${pdfPath}`;
  const qrDataURL = await QRCode.toDataURL(`${publicReportURL}|${publicPDFURL}`);
  const qrBuffer = saveBase64ToBuffer(qrDataURL);
  doc.image(qrBuffer, doc.page.width - 150, doc.page.height - 120, { width: 90 });

  doc.end();
  const pdfBuffer = await endPromise;

  // Subir a Storage
  const pdfUrl = await uploadToStorage("informes", pdfPath, pdfBuffer, "application/pdf");
  return pdfUrl;
}

function getTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// --------------------- ROUTES ---------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Crear reporte
app.post("/api/informes", upload.fields([{ name: "fotos" }, { name: "anexos" }]), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

    const id = uuidv4();
    const now = new Date().toISOString();
    const data = req.body;

    // Guardar firmas
    let firmaTecnicoUrl = null, firmaClienteUrl = null;
    if (data.firma_tecnico) {
      firmaTecnicoUrl = await uploadToStorage("informes", `firmas/${id}_tecnico.png`, saveBase64ToBuffer(data.firma_tecnico), "image/png");
    }
    if (data.firma_cliente) {
      firmaClienteUrl = await uploadToStorage("informes", `firmas/${id}_cliente.png`, saveBase64ToBuffer(data.firma_cliente), "image/png");
    }

    // Guardar fotos
    const fotos = [];
    for (let f of req.files["fotos"] || []) {
      const url = await uploadToStorage("informes", `fotos/${id}_${f.originalname}`, f.buffer, f.mimetype);
      fotos.push(url);
    }

    // Guardar anexos
    const anexos = [];
    for (let a of req.files["anexos"] || []) {
      const url = await uploadToStorage("informes", `anexos/${id}_${a.originalname}`, a.buffer, a.mimetype);
      anexos.push(url);
    }

    // Insertar en DB
    const { data: inserted, error } = await supabase.from("informes").insert([
      {
        id,
        created_at: now,
        updated_at: now,
        num_reporte: data.num_reporte,
        usuario: data.usuario,
        cliente: data.cliente,
        telefono: data.telefono,
        tipo_equipo: data.tipo_equipo,
        tipo_servicio: data.tipo_servicio,
        diagnostico: data.diagnostico,
        trabajos: data.trabajos,
        observaciones: data.observaciones,
        estado: data.estado || "ENVIADO",
        firma_tecnico: firmaTecnicoUrl,
        firma_cliente: firmaClienteUrl,
        fotos,
        anexos,
        pdf_path: null,
      },
    ]).select();

    if (error) throw error;

    const report = inserted[0];
    const pdfUrl = await generatePDF(report, fotos, { firma_tecnico: firmaTecnicoUrl, firma_cliente: firmaClienteUrl });

    await supabase.from("informes").update({ pdf_path: pdfUrl }).eq("id", id);

    // Enviar correo
    const transporter = getTransporter();
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: MAIL_TO,
        subject: `Reporte ${report.num_reporte}_${report.usuario}_${report.created_at.slice(0, 10)}`,
        html: `<p>Nuevo reporte enviado.</p>
               <p><a href="${pdfUrl}">Descargar PDF</a></p>
               <p><a href="${BASE_URL}/public/report.html?id=${id}">Ver reporte online</a></p>`,
      });
    }

    res.json({ ok: true, id, pdf_url: pdfUrl });
  } catch (e) {
    console.error("❌ Error creando informe:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Listar informes
app.get("/api/informes", async (req, res) => {
  const { data, error } = await supabase.from("informes").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Obtener informe por ID
app.get("/api/informes/:id", async (req, res) => {
  const { data, error } = await supabase.from("informes").select("*").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: "Informe no encontrado" });
  res.json(data);
});

// --------------------- ERROR HANDLER ---------------------
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.message);
  res.status(500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
