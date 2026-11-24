import test from 'node:test';
import assert from 'node:assert/strict';
import { fromProfile, tex, url, TEMPLATE, PREAMBLE } from '../web/src/latex/fromProfile.js';

test('text is escaped for LaTeX and unsupported characters are dropped', () => {
  assert.equal(tex('R&D 100% $5 #1 a_b {x} ~ ^ \\'), 'R\\&D 100\\% \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}');
  assert.equal(tex('Café – “quoted” 🚀'), 'Café – “quoted”');
  assert.equal(tex('two\nlines'), 'two lines');
});

test('links: only http(s) and mailto, TeX specials escaped', () => {
  assert.equal(url('github.com/you'), 'https://github.com/you');
  assert.equal(url('https://x.dev/a#b?c=100%'), 'https://x.dev/a\\#b?c=100\\%');
  assert.equal(url('javascript:alert(1)'), '');
  assert.equal(url('mailto:pat@example.com'), 'mailto:pat@example.com');
  assert.equal(url(''), '');
});

test('a profile becomes a resume; empty sections are left out', () => {
  const doc = fromProfile({
    identity: { firstName: 'Pat', lastName: 'O’Neil & Co' },
    contact: { email: 'pat@example.com', phone: '617 555 0100' },
    address: { city: 'Boston', state: 'MA' },
    links: { github: 'github.com/pat', linkedin: 'javascript:bad' },
    education: [{ school: 'Northeastern University', degree: 'M.S.', field: 'CS', gpa: '3.8', startDate: '2024-09', endDate: '2026-05' }],
    experience: [{ company: 'Acme', title: 'Engineer', startDate: '2024-01', current: true, description: '- Built 50% faster search\n- Shipped #1 feature' }],
    skills: [],
  });
  assert.ok(doc.startsWith(PREAMBLE));
  assert.match(doc, /\{\\LARGE\\bfseries Pat O’Neil \\& Co\}/);
  assert.match(doc, /\\href\{https:\/\/github\.com\/pat\}\{github\.com\/pat\}/);
  assert.doesNotMatch(doc, /javascript/);
  assert.match(doc, /\\entry\{Northeastern University\}\{Sep 2024 -- May 2026\}\{M\.S\., CS\}\{GPA 3\.8\}/);
  assert.match(doc, /\\entry\{Engineer\}\{Jan 2024 -- Present\}\{Acme\}\{\}/);
  assert.match(doc, /\\item Built 50\\% faster search/);
  assert.match(doc, /\\item Shipped \\#1 feature/);
  assert.doesNotMatch(doc, /\\section\{Skills\}/);
  assert.ok(doc.trimEnd().endsWith('\\end{document}'));
  // An empty profile still gives a document that compiles.
  const blank = fromProfile({});
  assert.match(blank, /Your Name/);
  assert.doesNotMatch(blank, /\\section\{/);
});

test('the template keeps the settings that make PDFs readable and reproducible', () => {
  for (const line of ['\\input{glyphtounicode}', '\\pdfgentounicode=1', '\\pdfinfoomitdate=1', '\\pdftrailerid{}', '\\usepackage{lmodern}'])
    assert.ok(TEMPLATE.includes(line), line);
});
