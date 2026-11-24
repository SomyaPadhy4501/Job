//! Reading a resume: text out of the PDF or .docx ([`extract`]), then
//! rule-based fields out of the text ([`resume`]). Nothing leaves the server;
//! there is no AI service involved.

pub mod extract;
pub mod resume;

pub use extract::{ExtractError, extract_text};
pub use resume::{ParsedResume, parse_resume};

/// Stored with each parse, so resumes can be re-parsed when the rules improve.
pub const PARSER_VERSION: i16 = 1;
