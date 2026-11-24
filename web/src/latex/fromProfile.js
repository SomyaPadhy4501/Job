// A one-page LaTeX resume from the profile, and the blank template.
// Plain module (no React) so it can be tested with node --test.

// The preamble every generated resume uses. glyphtounicode + pdfgentounicode
// make the PDF's text readable by parsers (and this site's resume reader);
// the last three lines make identical source compile to identical bytes.
export const PREAMBLE = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage[margin=0.6in]{geometry}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage[hidelinks]{hyperref}
\input{glyphtounicode}
\pdfgentounicode=1
\pdfinfoomitdate=1
\pdftrailerid{}
\pdfsuppressptexinfo=-1

\pagestyle{empty}
\setlength{\parindent}{0pt}
\titleformat{\section}{\large\bfseries}{}{0em}{}[\titlerule]
\titlespacing{\section}{0pt}{10pt}{4pt}
\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=2pt}

% \entry{Left, bold}{Right}{Left, italic}{Right, italic}
\newcommand{\entry}[4]{\textbf{#1}\hfill #2\\\textit{#3}\hfill\textit{#4}\par\smallskip}`;

const KEEP = /[–—‘’“”•…]/;

/** Text for the document body: special characters escaped, characters the
 * T1 font can't show dropped. */
export function tex(value) {
  return [...String(value ?? '')]
    .filter((c) => c.codePointAt(0) <= 0x24f || KEEP.test(c))
    .join('')
    .replace(/\\/g, '\u0000')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\u0000/g, '\\textbackslash{}')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

/** A link target for \href: only http(s) and mailto, with the characters
 * TeX treats specially escaped. */
export function url(value) {
  let u = String(value ?? '').trim();
  if (!u) return '';
  // Another scheme (javascript:, data:, file:...) is never made a link.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(u) && !/^(?:https?:|mailto:)/i.test(u)) return '';
  if (!/^(?:https?:|mailto:)/i.test(u)) u = `https://${u}`;
  if (!/^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(u)) return '';
  return u.replace(/\\/g, '').replace(/([%#{}])/g, '\\$1');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(date) {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(String(date || ''));
  if (!m) return '';
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
}
function span(start, end, current) {
  const a = when(start);
  const b = current ? 'Present' : when(end);
  return a && b ? `${a} -- ${b}` : a || b;
}
const shown = (s) => String(s ?? '').trim();
const linkText = (u) => shown(u).replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '');

export function fromProfile(profile = {}) {
  const id = profile.identity || {};
  const contact = profile.contact || {};
  const addr = profile.address || {};
  const links = profile.links || {};
  const name = [id.firstName, id.middleName, id.lastName].map(shown).filter(Boolean).join(' ') || 'Your Name';

  const bits = [];
  const place = [addr.city, addr.state].map(shown).filter(Boolean).join(', ');
  if (place) bits.push(tex(place));
  if (shown(contact.phone)) bits.push(tex(contact.phone));
  if (shown(contact.email)) bits.push(`\\href{${url(`mailto:${contact.email}`)}}{${tex(contact.email)}}`);
  for (const key of ['linkedin', 'github', 'portfolio', 'website']) {
    const target = url(links[key]);
    if (target) bits.push(`\\href{${target}}{${tex(linkText(links[key]))}}`);
  }

  const out = [PREAMBLE, '', '\\begin{document}', '', '\\begin{center}', `{\\LARGE\\bfseries ${tex(name)}}\\\\[3pt]`];
  if (bits.length) out.push(bits.join(' $|$ '));
  out.push('\\end{center}');

  const education = (profile.education || []).filter((e) => shown(e.school) || shown(e.degree));
  if (education.length) {
    out.push('', '\\section{Education}');
    for (const e of education) {
      const degree = [shown(e.degree), shown(e.field)].filter(Boolean).join(', ');
      const gpa = shown(e.gpa) ? `GPA ${shown(e.gpa)}` : '';
      out.push(`\\entry{${tex(e.school)}}{${tex(span(e.startDate, e.endDate))}}{${tex(degree)}}{${tex(gpa)}}`);
    }
  }

  const experience = (profile.experience || []).filter((j) => shown(j.company) || shown(j.title));
  if (experience.length) {
    out.push('', '\\section{Experience}');
    for (const j of experience) {
      out.push(`\\entry{${tex(j.title)}}{${tex(span(j.startDate, j.endDate, j.current === true))}}{${tex(j.company)}}{${tex(j.location)}}`);
      const bullets = shown(j.description)
        .split(/\n+/)
        .map((b) => b.replace(/^\s*[-•*]\s*/, '').trim())
        .filter(Boolean);
      if (bullets.length) {
        out.push('\\begin{itemize}');
        for (const b of bullets) out.push(`  \\item ${tex(b)}`);
        out.push('\\end{itemize}');
      }
    }
  }

  const skills = (profile.skills || []).map(shown).filter(Boolean);
  if (skills.length) out.push('', '\\section{Skills}', tex(skills.join(', ')));

  out.push('', '\\end{document}', '');
  return out.join('\n');
}

export const TEMPLATE = fromProfile({
  identity: { firstName: 'Your', lastName: 'Name' },
  contact: { email: 'you@example.com', phone: '(555) 555-0100' },
  address: { city: 'City', state: 'ST' },
  links: { linkedin: 'linkedin.com/in/you', github: 'github.com/you' },
  education: [{ school: 'University Name', degree: 'Bachelor of Science', field: 'Computer Science', gpa: '3.8/4.0', startDate: '2022-09', endDate: '2026-05' }],
  experience: [
    {
      title: 'Software Engineer Intern',
      company: 'Company',
      location: 'City, ST',
      startDate: '2025-06',
      endDate: '2025-08',
      description: 'What you built, and the result (numbers help)\nAnother achievement',
    },
  ],
  skills: ['Python', 'Java', 'SQL', 'React'],
});
