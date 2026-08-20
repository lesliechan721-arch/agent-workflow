# Reference Audit

Use this reference only when reviewing a reference package, a large reference, or an active path
that loads several references.

## Audit trigger

A size signal only requires semantic review; it is not a defect by itself. Review a file when one of
these is true:

- it is roughly above 300 lines or 4000 estimated tokens;
- one active path loads several large references;
- one file serves independent branches;
- a typical branch needs only a small part of the file;
- the user explicitly asks about progressive disclosure.

## Per-reference checks

| Check                 | Question                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| Necessity             | What realistic failure appears if this content is removed?                |
| Single responsibility | Does the file serve one concept or execution branch?                      |
| Branch locality       | After the branch matches, is most of this file needed?                    |
| Pointer               | Can the agent reach it at the right time without loading it every run?    |
| Focus                 | Does it mix topics that can be loaded independently?                      |
| Co-location           | Are definition, rule and caveat owned in one place?                       |
| Freshness             | Do changing facts have a source, date and recheck policy?                 |
| Alternative           | Is the content better as a script, asset, environment lookup or deletion? |

For each representative active path, record the main document, loaded references, total bytes, token
estimate, pointer evidence and estimated unneeded-content ratio.

## Verdicts

`keep | add-index | split-by-branch | inline-core | move-to-script-or-data | delete-or-environment-lookup | needs-ablation`

Do not split a large, flat, authoritative reference when most of it is needed after the branch
matches. Do not preserve an unnecessary reference merely because its pointer is valid.
