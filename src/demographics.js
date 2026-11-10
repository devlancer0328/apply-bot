/** Profile-owned demographic answers. Equivalent labels never change the user's intent. */
const fold = value => String(value ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
export const isDemographicQuestion = label => /\bgender\b|\bsex\b|\bpronouns?\b|\brace\b|\bracial\b|\bethnic|\bhispanic\b|\blatino\b|\blatinx\b|\bveteran\b|\bmilitary\b|\barmed forces\b|\bdisabilit|\bdisabled\b|\btransgender\b|sexual orientation/i.test(String(label ?? ''));
export const isPronounAnswer = value => /^(?:he\s*\/\s*him(?:\s*\/\s*his)?|she\s*\/\s*her(?:\s*\/\s*hers)?|they\s*\/\s*them(?:\s*\/\s*theirs)?)(?:\s*\([^)]*\))?$/i.test(String(value ?? '').trim());

// Every wording a board uses for the one decision "I would rather not say".
// Matching is on the whole label, so a wording missing from here is a
// required question with no answer the profile can give: OneSource Virtual
// says "Decline to State" and makes gender, ethnicity and veteran status
// all required, and it parked a finished application for want of it.
const DECLINE = ['Decline to self-identify', 'Decline To Self Identify', 'Decline to State', 'Decline to Specify', "I don't wish to answer", 'I do not wish to answer', 'I do not want to answer', 'I do not wish to self-identify', "I don't wish to self-identify", 'I decline to self-identify', 'Prefer not to say', 'I prefer not to answer', 'Prefer not to disclose', 'Choose not to disclose', 'Not Declared', 'Decline to answer', "I don't wish to disclose", 'Decline'];
const declined = value => /^(?:(?:i )?decline(?: to (?:self identify|state|specify|answer))?|(?:i )?(?:do not|don't) wish to (?:answer|disclose|self identify)|(?:i )?prefer not to (?:say|answer|disclose)|not declared)$/.test(fold(value));
/**
 * Every spelling of one pronoun set, longest first. The order is the
 * preference order used when the control's entries cannot be read, where
 * the fuller form is the more likely listing.
 */
const PRONOUN_SETS = {
  he: ['He/Him/His', 'He/Him', 'He', 'Him'],
  she: ['She/Her/Hers', 'She/Her', 'She', 'Her'],
  they: ['They/Them/Theirs', 'They/Them', 'They', 'Them'],
};

export function chooseDemographicOption(options, candidates) {
  // Workday appends the form's country to its choice labels. That annotation
  // does not change identity; ethnic qualifiers such as "not Hispanic" do.
  // Spacing around a slash is typography, not meaning: a control offering
  // "He / Him" and a profile holding "He/Him" are the same answer.
  const label=value=>fold(value).replace(/\s*\/\s*/g,'/').replace(/\s*\((?:united states(?: of america)?|u\.?s\.?a?\.?)\)\s*$/i,'').trim();
  for (const candidate of candidates) {
    const match = options.find(option=>label(option.label || option.value) === label(candidate));
    if (match) return match;
  }
  // "I would rather not say" is one decision with no canonical wording, and
  // the list of spellings below will never be complete - Reddit's "I prefer
  // not to say" is not on it. Where the applicant has declined, any entry
  // that reads as declining is the entry they meant.
  if (candidates.some(declined)) {
    const match = options.find(option=>declined(option.label || option.value));
    if (match) return match;
  }
  return null;
}

/** Specific racial identities can map to a broader category, never the reverse. */
export function demographicWordings(rule, value, profile={}) {
  const original = String(value ?? '').trim();
  if (!original) return [];
  const want = fold(original);
  let aliases = [];
  if (declined(original)) aliases = DECLINE;
  else if (rule === 'pronouns') {
    // How many of a set a control lists is a house style, not a different
    // answer: a profile saying "He/Him" against a menu of "He/him/his" is
    // the same person, and it parked four finished applications. The
    // subject pronoun is what identifies the set, so it chooses the set
    // and every common spelling of it is offered.
    aliases = PRONOUN_SETS[want.split(/[^a-z]+/)[0]] ?? [];
  } else if (rule === 'gender') {
    if (isPronounAnswer(original)) return [];
    if (/^(male|man|cisgender man|cisgender male)$/.test(want)) aliases = ['Male', 'Man'];
    else if (/^(female|woman|cisgender woman|cisgender female)$/.test(want)) aliases = ['Female', 'Woman'];
    else if (/^non ?binary$/.test(want)) aliases = ['Non-binary', 'Nonbinary', 'Non binary'];
  } else if (rule === 'sexual-orientation' && /^(straight|heterosexual|heterosexual (?:or|\/) straight)$/.test(want)) {
    aliases = ['Heterosexual or straight', 'Heterosexual / straight', 'Heterosexual', 'Straight'];
  } else if (rule === 'race') {
    if (/^(east|south|southeast|south east) asian$/.test(want)) aliases = ['Asian'];
    else if (/^(black|african american|black (?:or|\/) african american)$/.test(want)) aliases = ['Black or African American', 'Black / African American', 'Black', 'African American'];
  } else if (rule === 'veteran') {
    if (/^(no|no veteran|non veteran|not a veteran|i am not a veteran)$/.test(want)) {
      aliases = ['I am not a veteran', 'No, I am not a veteran or active member', 'I am not a protected veteran', 'Not a protected veteran', 'No'];
    } else if (/^(?:no,? )?(?:i am )?not a protected veteran$/.test(want)) {
      aliases = ['I am not a protected veteran', 'No, I am not a protected veteran', 'Not a protected veteran'];
    }
  } else if (rule === 'disability' && /^(no|no disability|no, i (?:do not|don't) have a disability)$/.test(want)) {
    aliases = ['No, I do not have a disability', "No, I don't have a disability", 'No, I do not have a disability or a history/record of having a disability', 'No, I do not have a disability and have not had one in the past', 'No'];
  } else if (rule === 'disability' && /^(yes|yes, i have a disability)$/.test(want)) {
    aliases = ['Yes, I have a disability', 'Yes, I have a disability, or have had one in the past', 'Yes'];
  }
  const values=[original,...aliases];
  if(rule==='race'&&!declined(original)&&profile.hispanic==='no')for(const race of [...values]){
    values.push(`${race} (Not Hispanic or Latino)`,`${race} - Not Hispanic or Latino`);
  }
  return [...new Set(values)];
}
