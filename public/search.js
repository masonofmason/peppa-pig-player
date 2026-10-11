// 제목 검색어 해석: 한글 단어는 단어장(ko-dictionary.js)으로 영어로 바꿔 찾는다.
//
// compileQuery('조지랑 공룡 cake') →
//   groups: [ [george], [dinosaur], [cake] ]   (그룹끼리는 AND, 그룹 안의 단어는 OR)
//   translated: [{ ko: '조지', en: ['george'] }, { ko: '공룡', en: ['dinosaur'] }]
//   unknown: []                                 (단어장에 없는 한글 단어)
import { KO_DICTIONARY, KO_NOISE } from './ko-dictionary.js?v=dev';

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const stripSpaces = (s) => s.replace(/\s+/g, '');

// 띄어쓰기를 뺀 한글 키 → 영어 목록. 같은 키가 여러 번 나오면 합친다.
const DICT = new Map();
for (const [ko, en] of Object.entries(KO_DICTIONARY)) {
  const key = stripSpaces(ko);
  DICT.set(key, [...new Set([...(DICT.get(key) || []), ...en.map((e) => e.toLowerCase())])]);
}
const MAX_KEY_LEN = Math.max(...[...DICT.keys()].map((k) => k.length));
const NOISE = [...KO_NOISE].sort((a, b) => b.length - a.length);

// 영어로 말하거나 칠 때 붙는 군더더기 ("show me muddy puddles", "play the dinosaur episode")
const EN_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'about', 'some', 'my',
  'i', 'me', 'want', 'wanna', 'watch', 'see', 'show', 'play', 'find', 'search', 'please', 'can', 'you',
  'video', 'videos', 'episode', 'episodes',
]);

// 제목과 검색어의 따옴표 모양을 맞춘다 (Peppa’s ↔ Peppa's)
const normalize = (s) => s.toLowerCase().replace(/[‘’`]/g, "'");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 영어 단어가 제목에 "단어로서" 있는지 본다 (sea가 season에 걸리지 않도록).
// 뒤에 붙는 s/es/'s 는 허용한다. 오래된 TV 브라우저를 위해 lookbehind는 쓰지 않는다.
function wordPattern(en) {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(en)}(?:s|es|'s|’s)?(?![a-z0-9])`, 'i');
}

// 단어장에 없는 한글 덩어리에서 끝에 붙은 조사·군더더기를 떼어내고, 남은 게 2글자 이상이면 "모르는 단어".
// (가운데 글자는 지우지 않는다: '뽀로로'의 '로'는 조사가 아니다)
function leftoverWord(run) {
  if (NOISE.includes(run)) return '';
  let rest = run;
  let singleStripped = false; // 한 글자 조사는 한 번만 뗀다 (뽀로로 → 뽀로 → 뽀 가 되지 않도록)
  for (;;) {
    const suffix = NOISE.find((n) => rest.length > n.length && rest.endsWith(n) && (n.length > 1 || !singleStripped));
    if (!suffix) break;
    rest = rest.slice(0, -suffix.length);
    if (suffix.length === 1) singleStripped = true;
  }
  if (NOISE.includes(rest)) return '';
  return rest.length >= 2 ? run : '';
}

// 한글 문자열을 왼쪽부터 가장 긴 단어장 단어로 잘라 나간다.
// 단어장 단어는 띄어쓰기를 넘어서도 찾지만('아빠 돼지'), 모르는 단어는 띄어쓰기에서 끊는다.
function translateHangul(text, translated, unknown) {
  const chars = [];
  const startsWord = [];
  for (const word of text.trim().split(/\s+/)) {
    [...word].forEach((ch, j) => { chars.push(ch); startsWord.push(j === 0); });
  }
  const s = chars.join('');
  let run = '';
  const flushRun = () => {
    const word = leftoverWord(run);
    if (word) unknown.push(word);
    run = '';
  };
  for (let i = 0; i < s.length;) {
    let matched = null;
    for (let len = Math.min(MAX_KEY_LEN, s.length - i); len > 0; len--) {
      const piece = s.slice(i, i + len);
      if (DICT.has(piece)) { matched = piece; break; }
    }
    if (matched) {
      flushRun();
      translated.push({ ko: matched, en: DICT.get(matched) });
      i += matched.length;
    } else {
      if (startsWord[i]) flushRun();
      run += s[i];
      i += 1;
    }
  }
  flushRun();
}

export function compileQuery(query) {
  const translated = [];
  const unknown = [];
  const english = [];
  let hangul = '';

  // 한글 부분과 영어/숫자 부분을 나눈다. 한글은 이어 붙여 띄어쓰기와 무관하게 해석한다.
  for (const token of normalize(query).split(/\s+/).filter(Boolean)) {
    if (HANGUL.test(token)) {
      // "조지cake"처럼 붙어 있으면 한글/비한글로 다시 쪼갠다
      for (const part of token.match(/[ㄱ-ㆎ가-힣]+|[^ㄱ-ㆎ가-힣]+/g)) {
        if (HANGUL.test(part)) hangul += ` ${part}`;
        else if (part.trim()) english.push(part.trim());
      }
    } else {
      english.push(token);
    }
  }
  if (hangul) translateHangul(hangul, translated, unknown);

  // 영어 군더더기는 빼되, 전부 군더더기면("the") 그대로 둔다
  const meaningful = english.filter((e) => !EN_STOPWORDS.has(e));
  const englishTerms = meaningful.length ? meaningful : english;

  const groups = [
    ...translated.map((t) => ({ type: 'words', patterns: t.en.map(wordPattern) })),
    ...englishTerms.map((e) => ({ type: 'text', text: e })), // 직접 친 영어는 기존처럼 부분 일치
  ];
  return {
    groups,
    translated,
    unknown,
    // 한글을 입력했는데 하나도 알아듣지 못하면 아무것도 보여주지 않는다 (전체 목록이 나오면 헷갈린다)
    matchesNothing: unknown.length > 0 && groups.length === 0,
  };
}

export function matchTitle(compiled, title) {
  if (compiled.matchesNothing) return false;
  const t = normalize(title || '');
  return compiled.groups.every((g) =>
    g.type === 'text' ? t.includes(g.text) : g.patterns.some((re) => re.test(t)));
}
