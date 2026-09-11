import { LOGISTICS_WORDS, UNRELATED_WORDS } from './captcha-words.js';

// Берёт `count` случайных элементов без повторов
function pickRandom(arr, count) {
  const copy = [...arr];
  const picked = [];

  for (let i = 0; i < count && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(idx, 1)[0]);
  }

  return picked;
}

// Собирает одну капчу: 4 слова про грузоперевозки + 1 постороннее,
// вперемешку. Возвращает список слов и индекс правильного ("лишнего") ответа.
export function buildCaptchaChallenge() {
  const related = pickRandom(LOGISTICS_WORDS, 4);
  const [oddOne] = pickRandom(UNRELATED_WORDS, 1);

  const words = [...related, oddOne];

  // Перетасовка Фишера-Йетса, чтобы "лишнее" слово не всегда было последним
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }

  const correctIndex = words.indexOf(oddOne);

  return { words, correctIndex };
}