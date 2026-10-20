# Documentation rules

## Reference and scope

Use ASD-STE100 Issue 9 for AI-facing specifications, subagent briefs, and technical reports.
Use this project vocabulary with the writing rules.
This document does not replace the official dictionary.

The owner supplied the official Issue 9 PDF on 2026-10-13.
The writing rules and dictionary introduction are the reference for this conversion.
The project terms below are proposed terms, not approval from ASD.

Read the [official ASD description](https://www.asd-ste100.org/about_STE.html).
Obtain the [official standard](https://www.asd-ste100.org/STE_downloads.html) for a complete vocabulary review.

Use Humanize for human-facing guides, README files, release notes, and contributor communication.
Use plain language that fits the reader.
Do not change technical requirements to simplify the prose.
Keep commands, identifiers, and evidence exact.
If a document serves both audiences, identify each section's audience.

The STE writing rules below apply to AI-facing content and hardening notes.
They do not change application behavior or release requirements.

## Writing rules

1. Write one instruction in each sentence.
2. Start an instruction with its action verb.
3. If an action has a condition, put the condition first.
4. Use no more than 20 words in an instruction.
5. Use no more than 25 words in each descriptive sentence.
6. Use one topic in each paragraph.
7. Use no more than six sentences in each paragraph.
8. Name the person or component that does the action.
9. Use the same term for the same item.
10. Do not use contractions, slang, or unexplained abbreviations.
11. Separate instructions from descriptions.
12. Do not use a note to give an instruction.

Use the simple present, simple past, or simple future tense.
Do not use perfect or progressive verb forms.
Use active voice unless a description has an unknown actor.

Use each approved word with its approved meaning and part of speech.
Use American English spelling outside protected text.
Do not use semicolons in prose.

Keep a multi-word noun to three words when possible.
For a longer official name, give the full name before its short form.
Do not use an abstract phrasal verb when an approved verb gives the same meaning.

Start a vertical list with an introduction and a colon.
Start each list item with an uppercase letter.
End each complete sentence with a period.
Keep procedure lists separate from description lists.
Keep instructions, requirements, and limits outside notes.
Give the action and consequence in a risk notice.

Use 20 words or fewer for new prose when possible.
Do not remove a requirement to reduce sentence length.
Put complex conditions in a list.
Keep each condition and its result together.

In AI-facing content, use Humanize only to remove unnecessary prose.
Do not add casual language or vary technical terms to change the writing style.
In AI-facing content, the ASD-STE100 rules have priority over conversational style.

## Project vocabulary

| Term | Meaning |
|---|---|
| Backend | The services that process requests and store application data. |
| Frontend | The application that the user operates in a browser. |
| Candidate | A specified Git commit that has not completed the release checks. |
| Default branch | Backend `main` or frontend `master`. |
| Message | The stored encrypted content and its sender, recipient, and delivery data. |
| Client message ID | The UUID in `clientMessageId` that identifies one send command. |
| Message ID | The server UUID that identifies a stored message. |
| Envelope | The complete serialized encrypted message string. |
| Replay | A repeated command that returns the stored result without creating another message. |
| Retry | Another attempt to complete the same operation after a failure. |
| Outbox event | A database record that waits for broker publication. |
| Inbox record | A notification database record that confirms durable receipt of an event. |
| Event ID | The UUID that identifies one notification event. |
| Lease | Temporary permission for a worker to process a database record. |
| Lease token | The UUID that permits updates from the current worker attempt only. |
| Delivery status | The message state `NotDelivered`, `Delivered`, or `Seen`. |
| Release state | The file that identifies verified current and previous images. |
| Image digest | The registry SHA-256 value that identifies an image manifest. |
| Red result | A test failure before the required behavior is implemented. |
| Green result | A passing test result for the specified code and command. |

Use exact API names, identifiers, product names, and commands as technical terms.
Do not use a technical noun as a verb.
Define a new technical term before you use it in an instruction.

Use these verbs for specified computer operations only:

| Verb | Computer operation |
|---|---|
| Encrypt | Change plaintext into ciphertext. |
| Decrypt | Change ciphertext into plaintext with the required key. |
| Install | Put software in its required location and configuration. |
| Compile | Change source code into the required executable or artifact. |
| Deploy | Install a specified release in the target environment. |
| Publish | Send an event or artifact to its specified broker or registry. |
| Validate | Compare input with the specified computer contract. |
| Commit | Complete a database transaction or record changes in Git. |

Do not use these terms to replace ordinary verbs in other contexts.
Use an approved dictionary verb when it gives the same technical meaning.
For example, write "Do a test" instead of the general verb "test".
Write "Do a check" instead of the general verb "check".
Use "obey" for instructions, not "follow".
Use "start" instead of "begin".

## Evidence and protected text

Do not change these items during a language conversion:

- Source code and fenced command examples
- Raw test output and quoted records
- Checksums, commit IDs, UUIDs, versions, dates, and exit codes
- Requirements, limits, conditions, and exceptions
- File paths, API identifiers, URLs, and link destinations
- Checkbox states and recorded review decisions
- License text, copyright notices, and third-party notices.

Keep protected text exact, even if it does not use controlled English.
Identify quoted records as records, not current instructions.
If a record is historical, state its date and purpose.
Do not describe an implementation result as release approval.
Do not describe a partial test as proof of an untested behavior.

## Review procedure

1. Read the complete original document.
2. Identify instructions, descriptions, and protected text.
3. Rewrite the authored prose.
4. Compare all requirements with the original document.
5. Do a check of the sentence limits and project terms.
6. Make sure that protected text has not changed.
7. Make sure that document links still operate correctly.
8. Record any source-access or vocabulary-review limits.

A sentence-length check does not prove dictionary compliance.
For a complete ASD-STE100 review, a check of each word, meaning, and part of speech is necessary.
The supplied PDF permits this review, but it does not prove that the review is complete.
