require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB Connection ────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/scoreboard';
mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB connected')).catch(err => console.error('❌ MongoDB error:', err));

// ─── Schemas ───────────────────────────────────────────────────────────
const competitionTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

const medalEntrySchema = new mongoose.Schema({
  contestant: { type: String, required: true },
  team: { type: String, required: true, enum: ['Rumah Kuning', 'Rumah Biru', 'Rumah Merah', 'Rumah Hijau'] },
  category: { type: String, required: true },
  competitionType: { type: String, required: true },
  medalType: { type: String, required: true, enum: ['gold', 'silver', 'bronze'] },
  createdAt: { type: Date, default: Date.now }
});

// Single-document settings (only ever one row, upserted by key "main")
const settingsSchema = new mongoose.Schema({
  key:    { type: String, default: 'main', unique: true },
  gold:   { type: Number, default: 5 },
  silver: { type: Number, default: 3 },
  bronze: { type: Number, default: 1 }
});

const CompetitionType = mongoose.model('CompetitionType', competitionTypeSchema);
const MedalEntry      = mongoose.model('MedalEntry', medalEntrySchema);
const Settings        = mongoose.model('Settings', settingsSchema);

// Helper — always returns the one settings document, creating it if missing
async function getPoints() {
  let s = await Settings.findOne({ key: 'main' });
  if (!s) s = await Settings.create({ key: 'main' });
  return { gold: s.gold, silver: s.silver, bronze: s.bronze };
}

// ─── Settings API ──────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  res.json(await getPoints());
});

app.post('/api/settings', async (req, res) => {
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
});

// ─── Competition Types CRUD ────────────────────────────────────────────
app.get('/api/competition-types', async (req, res) => {
  const types = await CompetitionType.find().sort({ name: 1 });
  res.json(types);
});

app.post('/api/competition-types', async (req, res) => {
  try {
    const type = new CompetitionType({ name: req.body.name });
    await type.save();
    res.json(type);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/competition-types/:id', async (req, res) => {
  await CompetitionType.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ─── Medal Entries CRUD ────────────────────────────────────────────────
app.get('/api/medals', async (req, res) => {
  const { competitionType } = req.query;
  const filter = competitionType ? { competitionType } : {};
  const medals = await MedalEntry.find(filter).sort({ createdAt: -1 });
  res.json(medals);
});

app.post('/api/medals', async (req, res) => {
  try {
    const entry = new MedalEntry(req.body);
    await entry.save();
    res.json(entry);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/medals/:id', async (req, res) => {
  await MedalEntry.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// ─── Scoreboard Aggregation ────────────────────────────────────────────
app.get('/api/scoreboard', async (req, res) => {
  const { competitionType } = req.query;
  const filter = competitionType ? { competitionType } : {};

  const POINTS = await getPoints();
  const teams  = ['Rumah Kuning', 'Rumah Biru', 'Rumah Merah', 'Rumah Hijau'];
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
});

// ─── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
