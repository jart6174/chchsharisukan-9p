// Load env vars. The platform stores them in .env.development.local / .env.local,
// while dotenv only reads ".env" by default — so load all of them explicitly.
const fs = require('fs');
const path = require('path');
['.env', '.env.local', '.env.development.local', '.env.production.local'].forEach(f => {
  const p = path.join(__dirname, f);
  if (fs.existsSync(p)) require('dotenv').config({ path: p, override: false });
});
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType } = require('docx');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.docx' || ext === '.doc') return cb(null, true);
    cb(new Error('Only .docx/.doc files allowed'));
  }
});

// ─── MongoDB Connection ────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/scoreboard';

function connectDB() {
  mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 })
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => {
      console.error('❌ MongoDB connection failed:', err.message);
      // Retry instead of crashing so the site stays up.
      setTimeout(connectDB, 5000);
    });
}
connectDB();

// Small helper so async route errors never crash the process.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// If the DB isn't connected yet, fail fast with a clear message instead of hanging.
app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database connecting, please retry in a moment.' });
  }
  next();
});

// ─── Constants ───────────────────────────────────────────────────────────────
const VALID_TEAMS = ['Rumah Kuning', 'Rumah Biru', 'Rumah Merah', 'Rumah Hijau'];
const VALID_CATEGORIES = ['P Open', 'L Open', 'P14', 'P20', 'L14', 'L16', 'L20', 'Jemputan'];

// ─── Schemas ───────────────────────────────────────────────────────────
const competitionTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

const medalEntrySchema = new mongoose.Schema({
  contestant: { type: String, required: true },
  athlete: { type: mongoose.Schema.Types.ObjectId, ref: 'Athlete' }, // optional link to roster
  team: { type: String, required: true, enum: VALID_TEAMS },
  category: { type: String, required: true },
  competitionType: { type: String, required: true },
  medalType: { type: String, required: true, enum: ['gold', 'silver', 'bronze'] },
  createdAt: { type: Date, default: Date.now }
});

// Athlete roster — separate from medal entries so athletes can exist before winning anything
const athleteSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  number:   { type: String, trim: true },
  category: { type: String, enum: VALID_CATEGORIES, required: true },
  team:     { type: String, enum: VALID_TEAMS, required: true }
}, { timestamps: true });

// Single-document settings (only ever one row, upserted by key "main")
const settingsSchema = new mongoose.Schema({
  key:    { type: String, default: 'main', unique: true },
  gold:   { type: Number, default: 5 },
  silver: { type: Number, default: 3 },
  bronze: { type: Number, default: 1 }
});

const CompetitionType = mongoose.model('CompetitionType', competitionTypeSchema);
const MedalEntry      = mongoose.model('MedalEntry', medalEntrySchema);
const Athlete         = mongoose.model('Athlete', athleteSchema);
const Settings        = mongoose.model('Settings', settingsSchema);

// Helper — always returns the one settings document, creating it if missing
async function getPoints() {
  let s = await Settings.findOne({ key: 'main' });
  if (!s) s = await Settings.create({ key: 'main' });
  return { gold: s.gold, silver: s.silver, bronze: s.bronze };
}

// ─── Settings API ──────────────────────────────────────────────────────
app.get('/api/settings', wrap(async (req, res) => {
  res.json(await getPoints());
}));

app.post('/api/settings', wrap(async (req, res) => {
  const { gold, silver, bronze } = req.body;
  if ([gold, silver, bronze].some(v => typeof v !== 'number' || v < 0)) {
    return res.status(400).json({ error: 'All values must be non-negative numbers.' });
  }
  const s = await Settings.findOneAndUpdate(
    { key: 'main' },
    { gold, silver, bronze },
    { upsert: true, new: true }
  );
  res.json({ gold: s.gold, silver: s.silver, bronze: s.bronze });
}));

// ─── Competition Types CRUD ────────────────────────────────────────────
app.get('/api/competition-types', wrap(async (req, res) => {
  const types = await CompetitionType.find().sort({ name: 1 });
  res.json(types);
}));

app.post('/api/competition-types', wrap(async (req, res) => {
  try {
    const type = new CompetitionType({ name: req.body.name });
    await type.save();
    res.json(type);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.delete('/api/competition-types/:id', wrap(async (req, res) => {
  await CompetitionType.findByIdAndDelete(req.params.id);
  res.json({ success: true });
}));

// ─── Athletes CRUD ─────────────────────────────────────────────────────
app.get('/api/athletes', wrap(async (req, res) => {
  const { team, category } = req.query;
  const filter = {};
  if (team) filter.team = team;
  if (category) filter.category = category;
  const athletes = await Athlete.find(filter).sort({ name: 1 });
  res.json(athletes);
}));

app.post('/api/athletes', wrap(async (req, res) => {
  try {
    const athlete = new Athlete(req.body);
    await athlete.save();
    res.json(athlete);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.put('/api/athletes/:id', wrap(async (req, res) => {
  try {
    const athlete = await Athlete.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
    res.json(athlete);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.delete('/api/athletes/:id', wrap(async (req, res) => {
  await Athlete.findByIdAndDelete(req.params.id);
  res.json({ success: true });
}));

// ─── Import Athletes from .docx ───────────────────────────────────────
// Supports the school format: team name in filename/merged header cell,
// side-by-side category blocks (e.g. L14 + L16 sharing the same rows),
// plus a flat fallback: Name | Number | Category | Team
app.post('/api/admin/import-athletes', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const htmlResult = await mammoth.convertToHtml({ buffer: req.file.buffer });
  const html = htmlResult.value;

  function extractTables(html) {
    const tables = [];
    const tableRe = /<table[\s\S]*?<\/table>/gi;
    let tableMatch;
    while ((tableMatch = tableRe.exec(html)) !== null) {
      const tableHtml = tableMatch[0];
      const rows = [];
      const rowRe = /<tr[\s\S]*?<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
        const rowHtml = rowMatch[0];
        const cells = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cellMatch;
        while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
          const raw = cellMatch[1]
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ').trim();
          cells.push(raw);
        }
        if (cells.length) rows.push(cells);
      }
      if (rows.length) tables.push(rows);
    }
    return tables;
  }

  // Team names in THIS schema are full strings: "Rumah Kuning", not "Kuning"
  const TEAM_MAP = {
    merah: 'Rumah Merah', red: 'Rumah Merah', 'rumah merah': 'Rumah Merah',
    biru: 'Rumah Biru',   blue: 'Rumah Biru', 'rumah biru': 'Rumah Biru',
    hijau: 'Rumah Hijau', green: 'Rumah Hijau', 'rumah hijau': 'Rumah Hijau',
    kuning: 'Rumah Kuning', yellow: 'Rumah Kuning', 'rumah kuning': 'Rumah Kuning'
  };
  function normaliseTeam(raw) {
    if (!raw) return null;
    const key = raw.toLowerCase().trim();
    if (TEAM_MAP[key]) return TEAM_MAP[key];
    if (VALID_TEAMS.includes(raw.trim())) return raw.trim();
    for (const [k, v] of Object.entries(TEAM_MAP)) {
      if (key.includes(k)) return v;
    }
    return null;
  }

  // Category matcher — P/L + Open/digits, OR the literal word "Jemputan"
  const CAT_CELL_RE = /(?:kategori\s*)?([PL]\s*(?:Open|\d{2})|Jemputan)/i;
  function extractCategory(cellText) {
    const m = CAT_CELL_RE.exec(cellText);
    if (!m) return null;
    const raw = m[1].replace(/\s+/g, ' ').trim();
    return VALID_CATEGORIES.find(c => c.toLowerCase() === raw.toLowerCase()) || null;
  }

  let docTeam = normaliseTeam(req.file.originalname.replace(/[_\-\.]/g, ' '));

  const tables   = extractTables(html);
  const imported = [];
  const errors   = [];

  if (!docTeam && tables.length) {
    const firstCell = tables[0]?.[0]?.[0] || '';
    docTeam = normaliseTeam(firstCell);
  }

  for (const rows of tables) {
    let leftCat  = null;
    let rightCat = null;
    let tableTeam = docTeam;

    for (const cells of rows) {
      if (cells.length === 1) {
        const tm = normaliseTeam(cells[0]);
        if (tm) { tableTeam = tm; continue; }
      }

      const possibleLeftCat  = extractCategory(cells[0] || '');
      const possibleRightCat = cells.length >= 3
        ? extractCategory(cells[2] || '')
        : (cells.length === 2 ? extractCategory(cells[1] || '') : null);

      if (possibleLeftCat || possibleRightCat) {
        if (possibleLeftCat)  leftCat  = possibleLeftCat;
        if (possibleRightCat) rightCat = possibleRightCat;
        if (possibleLeftCat && cells.length <= 2) { leftCat = possibleLeftCat; rightCat = null; }
        continue;
      }

      if (/no\.?\s*peserta|nombor|number/i.test(cells[0] || '') ||
          /nama|name/i.test(cells[1] || '')) continue;

      if (cells.length >= 4 && !leftCat && !rightCat) {
        const [rawName, rawNum, rawCat, rawTeam] = cells;
        const cat  = VALID_CATEGORIES.find(c => c.toLowerCase() === rawCat.toLowerCase());
        const team = normaliseTeam(rawTeam);
        if (!cat)  { if (rawName) errors.push(`Skipped "${rawName}": unknown category "${rawCat}"`); continue; }
        if (!team) { if (rawName) errors.push(`Skipped "${rawName}": unknown team "${rawTeam}"`); continue; }
        if (!rawName) continue;
        try {
          const ath = await Athlete.findOneAndUpdate(
            { name: rawName, team },
            { name: rawName, number: rawNum || '', category: cat, team },
            { upsert: true, new: true, runValidators: true }
          );
          imported.push(ath);
        } catch (e) { errors.push(`Failed to save "${rawName}": ${e.message}`); }
        continue;
      }

      const saveAthlete = async (num, name, cat, team) => {
        if (!name || !cat || !team) return;
        if (/^no\.?\s*peserta|nama|number|name$/i.test(name)) return;
        try {
          const ath = await Athlete.findOneAndUpdate(
            { name, team },
            { name, number: num || '', category: cat, team },
            { upsert: true, new: true, runValidators: true }
          );
          imported.push(ath);
        } catch (e) { errors.push(`Failed to save "${name}": ${e.message}`); }
      };

      const leftNum  = cells[0] || '';
      const leftName = cells[1] || '';
      if (leftName && leftCat && tableTeam) {
        await saveAthlete(leftNum, leftName, leftCat, tableTeam);
      }

      if (cells.length >= 4) {
        const rightNum  = cells[2] || '';
        const rightName = cells[3] || '';
        if (rightName && rightCat && tableTeam) {
          await saveAthlete(rightNum, rightName, rightCat, tableTeam);
        }
      }
    }
  }

  res.json({ imported: imported.length, errors, team: docTeam });
}));

// ─── Export Results to .docx ──────────────────────────────────────────
app.get('/api/admin/export-results', wrap(async (req, res) => {
  const POINTS = await getPoints();
  const entries = await MedalEntry.find({}).sort({ category: 1, createdAt: 1 });
  const now = new Date();

  const teamColors = { 'Rumah Merah': 'FF4444', 'Rumah Biru': '4488FF', 'Rumah Hijau': '44BB44', 'Rumah Kuning': 'FFCC00' };

  const tally = {};
  VALID_TEAMS.forEach(t => { tally[t] = { gold: 0, silver: 0, bronze: 0, points: 0 }; });
  entries.forEach(e => {
    if (!tally[e.team]) return;
    tally[e.team][e.medalType === 'gold' ? 'gold' : e.medalType === 'silver' ? 'silver' : 'bronze']++;
    tally[e.team].points += POINTS[e.medalType] || 0;
  });

  const makeCell = (text, bold = false, shading = null) => {
    const cellOpts = {
      children: [new Paragraph({
        children: [new TextRun({ text: String(text), bold, size: 22, font: 'Calibri' })],
        alignment: AlignmentType.CENTER
      })],
      borders: {
        top:    { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' },
        left:   { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' },
        right:  { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' }
      },
      margins: { top: 80, bottom: 80, left: 120, right: 120 }
    };
    if (shading) cellOpts.shading = { type: ShadingType.CLEAR, fill: shading };
    return new TableCell(cellOpts);
  };
  const makeHeaderRow = (cols, bg = 'CC0000') => new TableRow({
    children: cols.map(c => makeCell(c, true, bg)),
    tableHeader: true
  });

  const tallyRows = [
    makeHeaderRow(['PASUKAN / TEAM', 'EMAS', 'PERAK', 'GANGSA', 'MATA'], '1A1A2E'),
    ...VALID_TEAMS.map(team => new TableRow({
      children: [
        makeCell(team.toUpperCase(), true, teamColors[team] || 'CCCCCC'),
        makeCell(tally[team].gold, true),
        makeCell(tally[team].silver, true),
        makeCell(tally[team].bronze, true),
        makeCell(tally[team].points, true)
      ]
    }))
  ];

  const byCategory = {};
  VALID_CATEGORIES.forEach(c => { byCategory[c] = []; });
  entries.forEach(e => { if (byCategory[e.category]) byCategory[e.category].push(e); });

  const entrySections = [];
  for (const [cat, catEntries] of Object.entries(byCategory)) {
    if (!catEntries.length) continue;
    entrySections.push(new Paragraph({ text: `Kategori: ${cat}`, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 100 } }));
    const rows = [makeHeaderRow(['PESERTA', 'PASUKAN', 'PERTANDINGAN', 'MEDAL'], '2D3748')];
    catEntries.forEach(e => {
      const medalLabel = e.medalType === 'gold' ? 'Emas' : e.medalType === 'silver' ? 'Perak' : 'Gangsa';
      rows.push(new TableRow({
        children: [makeCell(e.contestant), makeCell(e.team), makeCell(e.competitionType), makeCell(medalLabel)]
      }));
    });
    entrySections.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  }

  const rosterSections = [];
  for (const team of VALID_TEAMS) {
    const athletes = await Athlete.find({ team }).sort({ category: 1, name: 1 });
    if (!athletes.length) continue;
    rosterSections.push(new Paragraph({ text: `Senarai Atlet - ${team}`, heading: HeadingLevel.HEADING_2, spacing: { before: 400, after: 100 } }));
    const rosterRows = [makeHeaderRow(['NO.', 'NAMA ATLET', 'NOMBOR', 'KATEGORI'], (teamColors[team] || 'CCCCCC'))];
    athletes.forEach((ath, i) => {
      rosterRows.push(new TableRow({
        children: [makeCell(i + 1), makeCell(ath.name), makeCell(ath.number || '-'), makeCell(ath.category)]
      }));
    });
    rosterSections.push(new Table({ rows: rosterRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  }

  const doc = new Document({
    styles: { paragraphStyles: [{ id: 'Normal', name: 'Normal', run: { font: 'Calibri', size: 22 } }] },
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children: [
        new Paragraph({
          children: [new TextRun({ text: 'SMJK CHUNG HWA CONFUCIAN', bold: true, size: 36, font: 'Calibri' })],
          alignment: AlignmentType.CENTER
        }),
        new Paragraph({
          children: [new TextRun({ text: 'LAPORAN HARI SUKAN / SPORTS DAY REPORT', bold: true, size: 28, font: 'Calibri', color: 'CC0000' })],
          alignment: AlignmentType.CENTER, spacing: { after: 80 }
        }),
        new Paragraph({
          children: [new TextRun({ text: `Dijana / Generated: ${now.toLocaleString('ms-MY')}`, size: 20, color: '666666' })],
          alignment: AlignmentType.CENTER, spacing: { after: 300 }
        }),
        new Paragraph({ text: 'TUNJUK MATA KESELURUHAN / OVERALL MEDAL TALLY', heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 150 } }),
        new Table({ rows: tallyRows, width: { size: 100, type: WidthType.PERCENTAGE } }),
        new Paragraph({ text: 'KEPUTUSAN / RESULTS', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }),
        ...entrySections,
        new Paragraph({ text: 'SENARAI ATLET / ATHLETE ROSTER', heading: HeadingLevel.HEADING_1, spacing: { before: 600, after: 200 } }),
        ...rosterSections,
        new Paragraph({
          children: [new TextRun({ text: 'Made by Jayden Tan Zheng Yu | IPGC Software', size: 18, color: '999999' })],
          alignment: AlignmentType.CENTER, spacing: { before: 600 }
        })
      ]
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  const filename = `HariSukan_Results_${now.toISOString().split('T')[0]}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

// ─── Medal Entries CRUD ────────────────────────────────────────────────
app.get('/api/medals', wrap(async (req, res) => {
  const { competitionType } = req.query;
  const filter = competitionType ? { competitionType } : {};
  const medals = await MedalEntry.find(filter).sort({ createdAt: -1 });
  res.json(medals);
}));

app.post('/api/medals', wrap(async (req, res) => {
  try {
    const entry = new MedalEntry(req.body);
    await entry.save();
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.delete('/api/medals/:id', wrap(async (req, res) => {
  await MedalEntry.findByIdAndDelete(req.params.id);
  res.json({ success: true });
}));

// ─── Scoreboard Aggregation ────────────────────────────────────────────
app.get('/api/scoreboard', wrap(async (req, res) => {
  const { competitionType } = req.query;
  const filter = competitionType ? { competitionType } : {};

  const POINTS = await getPoints();
  const teams  = VALID_TEAMS;
  const entries = await MedalEntry.find(filter);

  const board = teams.map(team => {
    const te     = entries.filter(e => e.team === team);
    const gold   = te.filter(e => e.medalType === 'gold').length;
    const silver = te.filter(e => e.medalType === 'silver').length;
    const bronze = te.filter(e => e.medalType === 'bronze').length;
    const points = gold * POINTS.gold + silver * POINTS.silver + bronze * POINTS.bronze;
    return { team, gold, silver, bronze, points };
  });

  board.sort((a, b) => b.points - a.points || b.gold - a.gold || b.silver - a.silver);
  res.json(board);
}));

// ─── Last Updated (for public page "Updated: [time]" display) ─────────
app.get('/api/last-updated', wrap(async (req, res) => {
  const latest = await MedalEntry.findOne({}).sort({ createdAt: -1 }).select('createdAt');
  res.json({ lastUpdated: latest ? latest.createdAt : null });
}));

// ─── Factory Reset (wipes ALL data: medals, athletes, competition types, settings) ─
app.post('/api/admin/factory-reset', wrap(async (req, res) => {
  if (req.body?.confirm !== 'RESET') {
    return res.status(400).json({ error: 'Confirmation phrase missing or incorrect.' });
  }
  await Promise.all([
    MedalEntry.deleteMany({}),
    Athlete.deleteMany({}),
    CompetitionType.deleteMany({}),
    Settings.deleteMany({})
  ]);
  await Settings.create({ key: 'main', gold: 5, silver: 3, bronze: 1 });
  res.json({ success: true });
}));

// ─── Error handler (keeps the process alive on any route error) ────────
app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

// ─── Start ─────────────────────────────────────────────────────────────
// Locally we listen on a port. On Vercel the app is used as a serverless
// handler via the export below, so we only call listen outside of Vercel.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}

// Last-resort guards so an unexpected error never takes the whole site down.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message || err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err?.message || err));

module.exports = app;
