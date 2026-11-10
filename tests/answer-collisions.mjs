/**
 * Rules claiming questions that belong to other rules.
 *
 * The resolver is an ordered list, so the first pattern that matches a
 * label answers it. That is fast and readable and has one failure mode,
 * which keeps happening: a rule matching on a word that appears in the
 * question *incidentally* takes a question another rule owns, and answers
 * it with something from entirely the wrong category.
 *
 * It is hard to notice because nothing errors. The form is filled, the
 * application is sent, and the wrong answer is only visible to the
 * employer reading it.
 *
 * These are the ones found by re-resolving every question/answer pair the
 * bot had actually written to an Answers.txt sheet - 302 of them, from a
 * single night - and looking for answers of the wrong *kind* for the
 * question asked. Each case below was sent to a real employer.
 *
 * The categories are worth keeping distinct, because they are not equally
 * bad:
 *
 *   A false statement. "Are you currently on an OPT or H-1B visa?"
 *   answered "Yes" for a US citizen is not an untidy application, it is a
 *   declaration that is not true. This is the one class of bug the
 *   judgement rules exist to prevent.
 *
 *   Somebody else's details asked for and the applicant's given. Naming
 *   yourself as your own referrer.
 *
 *   An answer of the wrong type. "9" to a question asking which
 *   programming languages you know; an email address to an essay. Merely
 *   embarrassing, but sent over a signature all the same.
 */

import assert from "node:assert/strict";
import { resolveField } from "../src/answers.js";
import { withDefaults } from "../src/profile.js";

let count = 0;
const test = (name, work) => { work(); count++; console.log("PASS " + name); };

const CITIZEN = withDefaults({
  firstName: "Daniel", lastName: "Torres", email: "someone@example.test", phone: "+1 (929) 489-1252",
  city: "Temple", state: "Texas", country: "United States", street: "1002 S 43rd St",
  workAuthorization: "us-citizen", requiresSponsorship: "no", techYears: 9, howHeard: "Company website",
});
const ON_A_VISA = withDefaults({ ...CITIZEN, workAuthorization: "visa-holder", requiresSponsorship: "yes" });
const NEEDS_ONE = withDefaults({ ...CITIZEN, workAuthorization: "needs-sponsorship", requiresSponsorship: "yes" });

const ask = (label, profile = CITIZEN, options = [], type = "text") =>
  resolveField({ label, type, required: true, options: options.map((o) => ({ label: o, value: o })) }, profile, { company: "Acme" });

// --- A false statement -------------------------------------------------

test("a citizen is not on a visa, whatever the question says about authorization", () => {
  // Mission Underwriting. The authorization rule took this on the words
  // "work authorization" at the end and answered Yes, which went out on a
  // signed application for somebody holding no visa at all.
  const asked = "Are you currently on an OPT , STEM, EAD, H1-B Visa or any other type of Visa that supports your work authorization?";
  assert.equal(ask(asked, CITIZEN, ["Yes", "No"]).rule, "holds-visa");
  assert.equal(ask(asked, CITIZEN, ["Yes", "No"]).value, "No");
  assert.equal(ask(asked, withDefaults({ ...CITIZEN, workAuthorization: "permanent-resident" }), ["Yes", "No"]).value, "No");
  // And it is a yes for somebody who does hold one.
  assert.equal(ask(asked, ON_A_VISA, ["Yes", "No"]).value, "Yes");
});

test("needing sponsorship says nothing about holding a visa today, so it asks", () => {
  // An applicant who needs sponsorship may be on an expiring F-1 OPT or
  // may be overseas on nothing. Guessing between those is how the bug
  // above was written in the first place.
  assert.notEqual(ask("Do you currently hold a visa?", NEEDS_ONE, ["Yes", "No"]).outcome, "fill");
});

test("the plain authorization questions are untouched", () => {
  for (const asked of [
    "Are you legally authorized to work in the United States?",
    "Are you authorized to work in the US without sponsorship?",
    "Do you have the right to work in the country where this role is located?",
  ]) {
    const result = ask(asked, CITIZEN, ["Yes", "No"]);
    assert.equal(result.rule, "authorization", asked);
    assert.equal(result.value, "Yes", asked);
  }
});

// --- Somebody else's details -------------------------------------------

test("a referrer's email is not the applicant's email", () => {
  // Newfold Digital was sent the applicant's own address as the name of
  // whoever referred them.
  for (const asked of ["What's their name or email address?", "If you were referred, what's their name or email address?"]) {
    const result = ask(asked);
    assert.notEqual(result.value, CITIZEN.email, asked);
    assert.notEqual(result.rule, "email", asked);
    assert.notEqual(result.rule, "city", asked);
  }
});

// --- An answer of the wrong type ---------------------------------------

test("a question asking which languages is not answered with a number", () => {
  // Hims & Hers, twice in one night, on two different roles.
  for (const asked of [
    "Which programming languages and tools do you consider yourself most proficient in when it comes to machine learning applications?",
    "What languages, frameworks and libraries are you most proficient with?",
    "Which databases and platforms are you most comfortable with?",
  ]) {
    const result = ask(asked);
    assert.notEqual(result.rule, "tech-experience", asked);
    assert.ok(!/^\d+$/.test(String(result.value ?? "")), `${asked} was answered with a bare number`);
  }
});

test("asking how long, or how well, with one tool named, is still the years rule", () => {
  for (const asked of [
    "How many years of experience do you have with Python?",
    "Rate your proficiency in SQL",
    "How proficient are you with Java?",
    "What is your level of experience with AWS?",
    "Years of experience",
  ]) {
    assert.equal(ask(asked).rule, "tech-experience", asked);
  }
});

test("an essay that mentions email is not answered with an email address", () => {
  // Awesome Motive builds email marketing software, so both of its
  // written questions mention email, and both were answered with
  // "danieltorres3274@gmail.com" and sent.
  for (const asked of [
    "If you had access to behavioral data from 30 million websites (form submissions, conversion flows, email engagement), what is the first thing you would build, and why?",
    "Say a small business owner shares their website and wants a popup that grows their email list. How would you approach an AI feature that creates it for them, and how would you know it's good?",
  ]) {
    assert.notEqual(ask(asked).value, CITIZEN.email, asked);
    assert.notEqual(ask(asked, CITIZEN, [], "textarea").value, CITIZEN.email, asked);
  }
});

test("the boxes that do want an address still get one", () => {
  for (const asked of ["Email", "Email Address", "Email *", "Work email", "Your email address", "What is your email?", "Confirm email address"]) {
    assert.equal(ask(asked).rule, "email", asked);
    assert.equal(ask(asked).value, CITIZEN.email, asked);
  }
});

test("a form spelling it E-Mail is not a form with no email box", () => {
  // `haystack` turns hyphens into spaces, so "E-Mail" arrived as "e mail"
  // and matched nothing. A required field, left blank, on any form using
  // that spelling.
  for (const asked of ["E-mail", "E-Mail", "E-mail address"]) {
    assert.equal(ask(asked).rule, "email", asked);
    assert.equal(ask(asked).value, CITIZEN.email, asked);
  }
});

console.log(`${count} answer-collision checks passed.`);
