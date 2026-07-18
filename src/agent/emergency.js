'use strict';
/**
 * Deterministic emergency pre-filter. Runs BEFORE the LLM on every inbound patient
 * message so an alert fires even if the model misjudges. English + Urdu script +
 * Roman Urdu variants for: heavy bleeding, facial swelling, trauma/knocked-out
 * tooth, severe uncontrolled pain, breathing difficulty.
 */
const PATTERNS = [
  // heavy/uncontrolled bleeding
  /(heavy|non[- ]?stop|uncontroll?ed|won'?t stop|still|bohat|buhat|bht).{0,20}(bleed|blood|khoon|خون)/i,
  /(bleed|blood|khoon|خون).{0,25}(won'?t stop|not stopping|nahi ruk|band nahi|ruk nahi)/i,
  /خون\s*(بہہ|نہیں رک)/,
  // facial swelling
  /(face|cheek|jaw|chehra|gaal|منہ|چہرہ|گال).{0,20}(swell|swoll?en|sooj|سوج)/i,
  /(swelling|soojan|سوجن).{0,20}(face|eye|cheek|jaw|chehray|badh|barh|spreading)/i,
  // trauma / knocked-out tooth
  /(knock(ed)? ?out|fell|broke|broken|accident|gir gaya|toot gaya|ٹوٹ).{0,20}(tooth|teeth|dant|daant|دانت)/i,
  /(tooth|dant|daant|دانت).{0,20}(knock(ed)? ?out|fell out|gir gaya|nikal gaya|toot)/i,
  // severe uncontrolled pain
  /(unbearable|severe|extreme|worst|shadeed|شدید|bardasht|bar-?dasht).{0,20}(pain|dard|درد)/i,
  /(pain|dard|درد).{0,30}(unbearable|can'?t (bear|sleep|take)|bardasht (nahi|se bahar)|شدید)/i,
  // breathing / systemic — always urgent
  /(can'?t|cannot|difficult|trouble|mushkil).{0,15}(breath|swallow|saans|سانس)/i,
  /(high )?fever.{0,20}(swelling|pain|soojan)/i,
];

function detectEmergency(text) {
  if (!text) return null;
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) return { matched: m[0] };
  }
  return null;
}

module.exports = { detectEmergency };
