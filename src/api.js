import { getConfig } from './config.js';

const BASE = 'https://leetcode.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export class AuthError extends Error {}

function headers(referer) {
  const cfg = getConfig();
  const h = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: BASE,
    Referer: referer || BASE + '/',
  };
  if (cfg.LEETCODE_SESSION) {
    h.Cookie = `LEETCODE_SESSION=${cfg.LEETCODE_SESSION}; csrftoken=${cfg.csrftoken || ''}`;
    if (cfg.csrftoken) h['x-csrftoken'] = cfg.csrftoken;
  }
  return h;
}

async function request(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error(`Network error reaching leetcode.com: ${e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(
      'LeetCode rejected the request (401/403). Your session cookie is missing or expired — run: lc login'
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${url}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function graphql(query, variables = {}) {
  const json = await request(`${BASE}/graphql`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  if (json.errors?.length) {
    throw new Error('GraphQL error: ' + json.errors.map((e) => e.message).join('; '));
  }
  return json.data;
}

export async function whoami() {
  const data = await graphql(`query { userStatus { isSignedIn username } }`);
  return data.userStatus;
}

export async function fetchQuestion(slug) {
  const data = await graphql(
    `query q($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionId
        questionFrontendId
        title
        titleSlug
        content
        difficulty
        isPaidOnly
        exampleTestcaseList
        sampleTestCase
        codeSnippets { lang langSlug code }
        topicTags { name }
        stats
      }
    }`,
    { titleSlug: slug }
  );
  if (!data.question) throw new Error(`Problem not found: "${slug}"`);
  return data.question;
}

export async function fetchProblemList({ limit = 25, skip = 0, difficulty, search } = {}) {
  const filters = {};
  if (difficulty) filters.difficulty = difficulty.toUpperCase();
  if (search) filters.searchKeywords = search;
  const data = await graphql(
    `query list($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList: questionList(
        categorySlug: $categorySlug
        limit: $limit
        skip: $skip
        filters: $filters
      ) {
        total: totalNum
        questions: data {
          frontendQuestionId: questionFrontendId
          title
          titleSlug
          difficulty
          status
          isPaidOnly
          acRate
        }
      }
    }`,
    { categorySlug: '', limit, skip, filters }
  );
  return data.problemsetQuestionList;
}

export async function fetchDaily() {
  const data = await graphql(
    `query {
      activeDailyCodingChallengeQuestion {
        date
        question { titleSlug title difficulty questionFrontendId }
      }
    }`
  );
  return data.activeDailyCodingChallengeQuestion;
}

// Resolve a frontend id (the number you see on the site) to a slug.
export async function slugFromId(id) {
  const data = await graphql(
    `query list($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList: questionList(
        categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters
      ) {
        questions: data { frontendQuestionId: questionFrontendId titleSlug }
      }
    }`,
    { categorySlug: '', limit: 5, skip: 0, filters: { searchKeywords: String(id) } }
  );
  const hit = data.problemsetQuestionList.questions.find(
    (q) => q.frontendQuestionId === String(id)
  );
  if (!hit) throw new Error(`No problem found with id ${id}`);
  return hit.titleSlug;
}

async function pollCheck(id, referer) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const json = await request(`${BASE}/submissions/detail/${id}/check/`, {
      headers: headers(referer),
    });
    if (json.state === 'SUCCESS') return json;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('Timed out waiting for LeetCode judge result (60s).');
}

// Run code against test input (the "Run" button). Returns judge result.
export async function runTests({ slug, questionId, lang, code, dataInput }) {
  const referer = `${BASE}/problems/${slug}/`;
  const json = await request(`${BASE}/problems/${slug}/interpret_solution/`, {
    method: 'POST',
    headers: headers(referer),
    body: JSON.stringify({
      lang,
      question_id: String(questionId),
      typed_code: code,
      data_input: dataInput,
    }),
  });
  if (!json.interpret_id) throw new Error('LeetCode did not accept the run: ' + JSON.stringify(json));
  return pollCheck(json.interpret_id, referer);
}

// Real submission. Returns judge result.
export async function submit({ slug, questionId, lang, code }) {
  const referer = `${BASE}/problems/${slug}/`;
  const json = await request(`${BASE}/problems/${slug}/submit/`, {
    method: 'POST',
    headers: headers(referer),
    body: JSON.stringify({ lang, question_id: String(questionId), typed_code: code }),
  });
  if (!json.submission_id) throw new Error('LeetCode did not accept the submission: ' + JSON.stringify(json));
  return pollCheck(json.submission_id, referer);
}
