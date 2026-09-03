export interface HashtagCourseDef {
  courseCode: string;
  aliases: string[];
}

export const FACEBOOK_HASHTAG_COURSES: HashtagCourseDef[] = [
  { courseCode: "INNER", aliases: ["inner", "innermakeover", "inner_makeover", "อินเนอร์", "อินเนอร์เมคโอเวอร์"] },
  { courseCode: "COMMU", aliases: ["commu", "communication", "mascom", "mastercommunication", "การสื่อสาร"] },
  { courseCode: "PRESENT", aliases: ["present", "presentation", "พรีเซนต์", "การนำเสนอ"] },
  { courseCode: "TTRT", aliases: ["ttrt", "thetrainer", "the_trainer", "trainer"] },
  { courseCode: "DEEPIN", aliases: ["deepin", "deep_in"] },
  { courseCode: "INNERCAMP", aliases: ["innercamp", "inner_camp"] },
];

function normalizeHashtag(value: string): string {
  return value.normalize("NFKC").trim().replace(/^#+/, "").replace(/[\s_-]+/g, "").toLowerCase();
}

const courseByAlias = new Map<string, string>();
for (const course of FACEBOOK_HASHTAG_COURSES) {
  for (const alias of course.aliases) courseByAlias.set(normalizeHashtag(alias), course.courseCode);
}

export function extractFacebookHashtags(message: string | null | undefined): string[] {
  if (!message) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of message.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const raw = `#${match[1]}`;
    const key = normalizeHashtag(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push(raw);
  }
  return found;
}

export function courseCodeFromHashtag(hashtag: string): string | null {
  return courseByAlias.get(normalizeHashtag(hashtag)) ?? null;
}

export interface HashtagCourseResult {
  courseCode: string | null;
  unknownHashtags: string[];
  ambiguous: boolean;
  unmapped: boolean;
}

export function mapHashtagsToCourse(hashtags: readonly string[]): HashtagCourseResult {
  const known = [...new Set(hashtags.flatMap((tag) => {
    const code = courseCodeFromHashtag(tag);
    return code ? [code] : [];
  }))];
  const unknownHashtags = hashtags.filter((tag) => courseCodeFromHashtag(tag) === null);
  const ambiguous = known.length > 1;
  const courseCode = known.length === 1 ? known[0]! : null;
  return {
    courseCode,
    unknownHashtags,
    ambiguous,
    unmapped: hashtags.length === 0 || unknownHashtags.length > 0 || ambiguous || courseCode === null,
  };
}
