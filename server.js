import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateShortCode() {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

const { ANTHROPIC_API_KEY, ADMIN_PASSWORD, PORT = 3000 } = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('Missing ADMIN_PASSWORD in .env');
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'Incorrect password.' });
});

async function readScores() {
  try {
    const raw = await fs.readFile(SCORES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeScores(scores) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SCORES_FILE, JSON.stringify(scores, null, 2), 'utf8');
}

app.post('/api/scores', async (req, res) => {
  const { quizId, quizTitle, name, correct, total, pct } = req.body || {};
  if (typeof quizId !== 'string' || !quizId ||
      typeof name !== 'string' || !name.trim() ||
      !Number.isFinite(correct) || !Number.isFinite(total) || !Number.isFinite(pct)) {
    return res.status(400).json({ error: 'Missing or invalid fields.' });
  }
  try {
    const cleanName = name.trim().substring(0, 80);
    const all = await readScores();
    const filtered = all.filter(s => !(s.quizId === quizId && s.name === cleanName));
    filtered.push({
      quizId,
      quizTitle: typeof quizTitle === 'string' ? quizTitle.substring(0, 200) : '',
      name: cleanName,
      correct,
      total,
      pct,
      ts: Date.now()
    });
    await writeScores(filtered);
    res.json({ ok: true });
  } catch (err) {
    console.error('scores POST error:', err);
    res.status(500).json({ error: 'Could not save score.' });
  }
});

async function readQuizzes() {
  try {
    const raw = await fs.readFile(QUIZZES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeQuizzes(quizzes) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(QUIZZES_FILE, JSON.stringify(quizzes, null, 2), 'utf8');
}

app.post('/api/quizzes', async (req, res) => {
  const { password, title, questions } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (typeof title !== 'string' || !title.trim() || !Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'Title and questions are required.' });
  }
  try {
    const all = await readQuizzes();
    let code = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateShortCode();
      if (!all[candidate]) { code = candidate; break; }
    }
    if (!code) return res.status(500).json({ error: 'Could not allocate a unique code.' });
    all[code] = {
      title: title.trim().substring(0, 200),
      questions,
      ts: Date.now()
    };
    await writeQuizzes(all);
    res.json({ code });
  } catch (err) {
    console.error('quizzes POST error:', err);
    res.status(500).json({ error: 'Could not save quiz.' });
  }
});

app.get('/api/quizzes/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const all = await readQuizzes();
    const quiz = all[code];
    if (!quiz) return res.status(404).json({ error: 'Quiz not found. Check the code with your teacher.' });
    res.json({ code, title: quiz.title, questions: quiz.questions, ts: quiz.ts });
  } catch (err) {
    console.error('quizzes GET error:', err);
    res.status(500).json({ error: 'Could not load quiz.' });
  }
});

app.get('/api/scores/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;
    const all = await readScores();
    const scores = all
      .filter(s => s.quizId === quizId)
      .sort((a, b) => b.pct - a.pct);
    res.json({ scores });
  } catch (err) {
    console.error('scores GET error:', err);
    res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

app.post('/api/generate-quiz', async (req, res) => {
  const { password, title, text } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!title || !text) {
    return res.status(400).json({ error: 'Title and tafseer text are required.' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3500,
      messages: [{
        role: 'user',
        content: `You are a Quran tafseer educator creating a quiz for a weekly study circle. Based on the following tafseer text, generate exactly 10 multiple choice questions. Questions should test deep understanding — not just surface recall. Include questions about meanings, context, lessons, and linguistic insights where possible.

Return ONLY a valid JSON array, no markdown fences, no preamble, no commentary. Format exactly:
[{"q":"Question?","options":["A. option","B. option","C. option","D. option"],"answer":"A"}]

Tafseer text:
${text}`
      }]
    });

    const raw = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    const questions = JSON.parse(raw);
    return res.json({ title, questions });
  } catch (err) {
    console.error('generate-quiz error:', err);
    const msg = err?.error?.message || err?.message || 'Generation failed.';
    return res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Quran Quiz Circle running at http://localhost:${PORT}`);
});
