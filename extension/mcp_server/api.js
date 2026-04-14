/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci */
"use strict";

/**
 * Thunderbird API Extension
 * Exposes email, calendar, and contacts via JSON-RPC over HTTP.
 *
 * Architecture: thunderbird-cli / thunderbird-api bridge --> This extension (port 8766)
 *
 * Key quirks documented inline:
 * - MIME header decoding (mime2Decoded* properties)
 * - HTML body charset handling (emojis require HTML entity encoding)
 * - Compose window body preservation (must use New type, not Reply)
 * - IMAP folder sync (msgDatabase may be stale)
 */

const resProto = Cc[
  "@mozilla.org/network/protocol;1?name=resource"
].getService(Ci.nsISubstitutingProtocolHandler);

const API_PORT = 8756;
const DEFAULT_MAX_RESULTS = 50;
const MAX_SEARCH_RESULTS_CAP = 200;
const SEARCH_COLLECTION_CAP = 1000;

var mcpServer = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const extensionRoot = context.extension.rootURI;
    const resourceName = "thunderbird-api";

    resProto.setSubstitutionWithFlags(
      resourceName,
      extensionRoot,
      resProto.ALLOW_CONTENT_ACCESS
    );

    const tools = [
      {
        name: "listAccounts",
        title: "List Accounts",
        description: "List all email accounts and their identities",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "searchMessages",
        title: "Search Mail",
        description: "Search message headers and return IDs/folder paths you can use with getMessage to read full email content",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search in subject, author, or recipients (use empty string to match all)" },
            startDate: { type: "string", description: "Filter messages on or after this ISO 8601 date" },
            endDate: { type: "string", description: "Filter messages on or before this ISO 8601 date" },
            maxResults: { type: "number", description: "Maximum number of results to return (default 50, max 200)" },
            sortOrder: { type: "string", description: "Date sort order: asc (oldest first) or desc (newest first, default)" }
          },
          required: ["query"],
        },
      },
      {
        name: "getMessage",
        title: "Get Message",
        description: "Read the full content of an email message by its ID, with optional attachment saving to disk",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            saveAttachments: { type: "boolean", description: "Save attachments to temp files and return file paths (default: false, returns metadata only)" },
            forceLarge: { type: "boolean", description: "Download attachments larger than 10MB (default: false, large files are deferred)" }
          },
          required: ["messageId", "folderPath"],
        },
      },
      {
        name: "sendMail",
        title: "Compose Mail",
        description: "Open a compose window with pre-filled recipient, subject, and body for user review before sending",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email address" },
            subject: { type: "string", description: "Email subject line" },
            body: { type: "string", description: "Email body text" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
            from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
            attachments: { type: "array", items: { type: "string" }, description: "Array of file paths to attach" },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "listCalendars",
        title: "List Calendars",
        description: "Return the user's calendars",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "createEvent",
        title: "Create Event",
        description: "Open a pre-filled event dialog in Thunderbird for user review before saving",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Event title" },
            startDate: { type: "string", description: "Start date/time in ISO 8601 format" },
            endDate: { type: "string", description: "End date/time in ISO 8601 (defaults to startDate + 1h for timed, +1 day for all-day)" },
            location: { type: "string", description: "Event location" },
            description: { type: "string", description: "Event description" },
            calendarId: { type: "string", description: "Target calendar ID (from listCalendars, defaults to first writable calendar)" },
            allDay: { type: "boolean", description: "Create an all-day event (default: false)" },
          },
          required: ["title", "startDate"],
        },
      },
      {
        name: "searchContacts",
        title: "Search Contacts",
        description: "Find contacts the user interacted with",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Email address or name to search for" }
          },
          required: ["query"],
        },
      },
      {
        name: "replyToMessage",
        title: "Reply to Message",
        description: "Open a reply compose window for a specific message with proper threading",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID to reply to (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            body: { type: "string", description: "Reply body text" },
            replyAll: { type: "boolean", description: "Reply to all recipients (default: false)" },
            isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
            to: { type: "string", description: "Override recipient email (default: original sender)" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
            attachments: { type: "array", items: { type: "string" }, description: "Array of file paths to attach" },
          },
          required: ["messageId", "folderPath", "body"],
        },
      },
      {
        name: "forwardMessage",
        title: "Forward Message",
        description: "Open a forward compose window for a message with attachments preserved",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID to forward (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            to: { type: "string", description: "Recipient email address" },
            body: { type: "string", description: "Additional text to prepend (optional)" },
            isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
            attachments: { type: "array", items: { type: "string" }, description: "Array of additional file paths to attach" },
          },
          required: ["messageId", "folderPath", "to"],
        },
      },
      {
        name: "listFolders",
        title: "List Folders",
        description: "List all mail folders with URIs and message counts",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Filter to a specific account ID (optional)" }
          },
          required: [],
        },
      },
      {
        name: "updateMessage",
        title: "Update Message",
        description: "Mark a message as read/unread, flag/unflag, move to another folder, or trash it",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            read: { type: "boolean", description: "Mark as read (true) or unread (false)" },
            flagged: { type: "boolean", description: "Mark as flagged (true) or unflagged (false)" },
            moveTo: { type: "string", description: "Folder URI to move the message to (from listFolders)" },
            trash: { type: "boolean", description: "Move the message to the Trash folder" }
          },
          required: ["messageId", "folderPath"],
        },
      },
      {
        name: "syncFolder",
        title: "Sync Folder",
        description: "Force a folder sync/refresh to get the latest messages from the server",
        inputSchema: {
          type: "object",
          properties: {
            folderPath: { type: "string", description: "Folder URI to sync (from listFolders)" },
            timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 30000)" }
          },
          required: ["folderPath"],
        },
      },
    ];

    return {
      mcpServer: {
        start: async function() {
          try {
            const { HttpServer } = ChromeUtils.importESModule(
              "resource://thunderbird-api/httpd.sys.mjs?" + Date.now()
            );
            const { NetUtil } = ChromeUtils.importESModule(
              "resource://gre/modules/NetUtil.sys.mjs"
            );
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );

            let cal = null;
            let CalEvent = null;
            try {
              const calModule = ChromeUtils.importESModule(
                "resource:///modules/calendar/calUtils.sys.mjs"
              );
              cal = calModule.cal;
              const { CalEvent: CE } = ChromeUtils.importESModule(
                "resource:///modules/CalEvent.sys.mjs"
              );
              CalEvent = CE;
            } catch {
              // Calendar not available
            }

            /**
             * CRITICAL: Must specify { charset: "UTF-8" } or emojis/special chars
             * will be corrupted. NetUtil defaults to Latin-1.
             */
            function readRequestBody(request) {
              const stream = request.bodyInputStream;
              return NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
            }

            /**
             * Thunderbird's httpd.sys.mjs writes response strings as raw bytes.
             * Pre-encode non-ASCII as UTF-8 byte chars and strip invalid controls.
             */
            function sanitizeForJson(text) {
              if (!text) return text;

              let sanitized = "";

              for (let i = 0; i < text.length; i++) {
                const code = text.charCodeAt(i);

                if (
                  (code >= 0x00 && code <= 0x08) ||
                  code === 0x0b ||
                  code === 0x0c ||
                  (code >= 0x0e && code <= 0x1f) ||
                  code === 0x7f
                ) {
                  continue;
                }

                if (code <= 0x7f) {
                  sanitized += text[i];
                  continue;
                }

                const codePoint = text.codePointAt(i);
                if (codePoint > 0xffff) {
                  sanitized += String.fromCharCode(
                    0xf0 | (codePoint >> 18),
                    0x80 | ((codePoint >> 12) & 0x3f),
                    0x80 | ((codePoint >> 6) & 0x3f),
                    0x80 | (codePoint & 0x3f)
                  );
                  i++;
                  continue;
                }

                if (codePoint <= 0x7ff) {
                  sanitized += String.fromCharCode(
                    0xc0 | (codePoint >> 6),
                    0x80 | (codePoint & 0x3f)
                  );
                  continue;
                }

                sanitized += String.fromCharCode(
                  0xe0 | (codePoint >> 12),
                  0x80 | ((codePoint >> 6) & 0x3f),
                  0x80 | (codePoint & 0x3f)
                );
              }

              return sanitized;
            }

            /**
             * Lists all email accounts and their identities.
             */
            function listAccounts() {
              const accounts = [];
              for (const account of MailServices.accounts.accounts) {
                const server = account.incomingServer;
                const identities = [];
                for (const identity of account.identities) {
                  identities.push({
                    id: identity.key,
                    email: identity.email,
                    name: identity.fullName,
                    isDefault: identity === account.defaultIdentity
                  });
                }
                accounts.push({
                  id: account.key,
                  name: server.prettyName,
                  type: server.type,
                  identities
                });
              }
              return accounts;
            }

            /**
             * Finds an identity by email address or identity ID.
             * Returns null if not found.
             */
            function findIdentity(emailOrId) {
              if (!emailOrId) return null;
              const lowerInput = emailOrId.toLowerCase();
              for (const account of MailServices.accounts.accounts) {
                for (const identity of account.identities) {
                  if (identity.key === emailOrId || (identity.email || "").toLowerCase() === lowerInput) {
                    return identity;
                  }
                }
              }
              return null;
            }

            /**
             * Adds file attachments to compose fields.
             * Returns { added: number, failed: string[] } for failure reporting.
             */
            function addAttachments(composeFields, attachments) {
              const result = { added: 0, failed: [] };
              if (!attachments || !Array.isArray(attachments)) return result;
              for (const filePath of attachments) {
                try {
                  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
                  file.initWithPath(filePath);
                  if (file.exists()) {
                    const attachment = Cc["@mozilla.org/messengercompose/attachment;1"]
                      .createInstance(Ci.nsIMsgAttachment);
                    attachment.url = Services.io.newFileURI(file).spec;
                    attachment.name = file.leafName;
                    attachment.size = file.fileSize;
                    composeFields.addAttachment(attachment);
                    result.added++;
                  } else {
                    result.failed.push(filePath);
                  }
                } catch {
                  result.failed.push(filePath);
                }
              }
              return result;
            }

            function escapeHtml(s) {
              return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }

            /**
             * Converts body text to HTML for compose fields.
             * Handles both HTML input (entity-encodes non-ASCII) and plain text.
             */
            function formatBodyHtml(body, isHtml) {
              if (isHtml) {
                let text = (body || "").replace(/\n/g, '');
                text = [...text].map(c => c.codePointAt(0) > 127 ? `&#${c.codePointAt(0)};` : c).join('');
                return text;
              }
              return escapeHtml(body || "").replace(/\n/g, '<br>');
            }

            /**
             * Sets compose identity from `from` param or falls back to default.
             * Returns warning string if `from` was specified but not found.
             */
            function setComposeIdentity(msgComposeParams, from, fallbackServer) {
              const identity = findIdentity(from);
              if (identity) {
                msgComposeParams.identity = identity;
                return "";
              }
              // Fallback to default identity for the account
              if (fallbackServer) {
                const account = MailServices.accounts.findAccountForServer(fallbackServer);
                if (account) msgComposeParams.identity = account.defaultIdentity;
              } else {
                const defaultAccount = MailServices.accounts.defaultAccount;
                if (defaultAccount) msgComposeParams.identity = defaultAccount.defaultIdentity;
              }
              return from ? `unknown identity: ${from}, using default` : "";
            }

            /**
             * Finds a message by ID in a folder. Returns { msgHdr, folder } or { error }.
             * Extracts the repeated folder-lookup + db-enumerate pattern.
             */
            function findMessage(messageId, folderPath) {
              const folder = MailServices.folderLookup.getFolderForURL(folderPath);
              if (!folder) {
                return { error: `Folder not found: ${folderPath}` };
              }

              const db = folder.msgDatabase;
              if (!db) {
                return { error: "Could not access folder database" };
              }

              let msgHdr = null;
              for (const hdr of db.enumerateMessages()) {
                if (hdr.messageId === messageId) {
                  msgHdr = hdr;
                  break;
                }
              }

              if (!msgHdr) {
                return { error: `Message not found: ${messageId}` };
              }

              return { msgHdr, folder };
            }

            function searchMessages(query, startDate, endDate, maxResults, sortOrder) {
              const results = [];
              const lowerQuery = (query || "").toLowerCase();
              const hasQuery = !!lowerQuery;
              const parsedStartDate = startDate ? new Date(startDate).getTime() : NaN;
              const parsedEndDate = endDate ? new Date(endDate).getTime() : NaN;
              const startDateTs = Number.isFinite(parsedStartDate) ? parsedStartDate * 1000 : null;
              // Add 24h only for date-only strings (no time component) to include the full day
              const endDateOffset = endDate && !endDate.includes("T") ? 86400000 : 0;
              const endDateTs = Number.isFinite(parsedEndDate) ? (parsedEndDate + endDateOffset) * 1000 : null;
              const requestedLimit = Number(maxResults);
              const effectiveLimit = Math.min(
                Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : DEFAULT_MAX_RESULTS,
                MAX_SEARCH_RESULTS_CAP
              );
              const normalizedSortOrder = sortOrder === "asc" ? "asc" : "desc";

              // Freshness metadata tracking
              let newestMessageDate = null;
              let totalScanned = 0;
              let foldersSearched = 0;

              function searchFolder(folder) {
                if (results.length >= SEARCH_COLLECTION_CAP) return;

                try {
                  // Attempt to refresh IMAP folders. This is async and may not
                  // complete before we read, but helps with stale data.
                  if (folder.server && folder.server.type === "imap") {
                    try {
                      folder.updateFolder(null);
                    } catch {
                      // updateFolder may fail, continue anyway
                    }
                  }

                  const db = folder.msgDatabase;
                  if (!db) return;

                  foldersSearched++;

                  for (const msgHdr of db.enumerateMessages()) {
                    if (results.length >= SEARCH_COLLECTION_CAP) break;

                    totalScanned++;

                    // IMPORTANT: Use mime2Decoded* properties for searching.
                    // Raw headers contain MIME encoding like "=?UTF-8?Q?...?="
                    // which won't match plain text searches.
                    const subject = (msgHdr.mime2DecodedSubject || msgHdr.subject || "").toLowerCase();
                    const author = (msgHdr.mime2DecodedAuthor || msgHdr.author || "").toLowerCase();
                    const recipients = (msgHdr.mime2DecodedRecipients || msgHdr.recipients || "").toLowerCase();
                    const ccList = (msgHdr.ccList || "").toLowerCase();
                    const msgDateTs = msgHdr.date || 0;

                    // Track the newest message date across all scanned messages
                    if (msgDateTs > 0 && (newestMessageDate === null || msgDateTs > newestMessageDate)) {
                      newestMessageDate = msgDateTs;
                    }

                    if (startDateTs !== null && msgDateTs < startDateTs) continue;
                    if (endDateTs !== null && msgDateTs > endDateTs) continue;

                    if (!hasQuery ||
                        subject.includes(lowerQuery) ||
                        author.includes(lowerQuery) ||
                        recipients.includes(lowerQuery) ||
                        ccList.includes(lowerQuery)) {
                      results.push({
                        id: msgHdr.messageId,
                        subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
                        author: msgHdr.mime2DecodedAuthor || msgHdr.author,
                        recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients,
                        ccList: msgHdr.ccList,
                        date: msgHdr.date ? new Date(msgHdr.date / 1000).toISOString() : null,
                        folder: folder.prettyName,
                        folderPath: folder.URI,
                        read: msgHdr.isRead,
                        flagged: msgHdr.isFlagged,
                        _dateTs: msgDateTs
                      });
                    }
                  }
                } catch {
                  // Skip inaccessible folders
                }

                if (folder.hasSubFolders) {
                  for (const subfolder of folder.subFolders) {
                    if (results.length >= SEARCH_COLLECTION_CAP) break;
                    searchFolder(subfolder);
                  }
                }
              }

              for (const account of MailServices.accounts.accounts) {
                if (results.length >= SEARCH_COLLECTION_CAP) break;
                searchFolder(account.incomingServer.rootFolder);
              }

              results.sort((a, b) => normalizedSortOrder === "asc" ? a._dateTs - b._dateTs : b._dateTs - a._dateTs);

              const messages = results.slice(0, effectiveLimit).map(result => {
                delete result._dateTs;
                return result;
              });

              return {
                messages,
                metadata: {
                  newestMessageDate: newestMessageDate ? new Date(newestMessageDate / 1000).toISOString() : null,
                  totalScanned,
                  foldersSearched
                }
              };
            }

            function searchContacts(query) {
              const results = [];
              const lowerQuery = query.toLowerCase();

              for (const book of MailServices.ab.directories) {
                for (const card of book.childCards) {
                  if (card.isMailList) continue;

                  const email = (card.primaryEmail || "").toLowerCase();
                  const displayName = (card.displayName || "").toLowerCase();
                  const firstName = (card.firstName || "").toLowerCase();
                  const lastName = (card.lastName || "").toLowerCase();

                  if (email.includes(lowerQuery) ||
                      displayName.includes(lowerQuery) ||
                      firstName.includes(lowerQuery) ||
                      lastName.includes(lowerQuery)) {
                    results.push({
                      id: card.UID,
                      displayName: card.displayName,
                      email: card.primaryEmail,
                      firstName: card.firstName,
                      lastName: card.lastName,
                      addressBook: book.dirName
                    });
                  }

                  if (results.length >= DEFAULT_MAX_RESULTS) break;
                }
                if (results.length >= DEFAULT_MAX_RESULTS) break;
              }

              return results;
            }

            function listCalendars() {
              if (!cal) {
                return { error: "Calendar not available" };
              }
              try {
                return cal.manager.getCalendars().map(c => ({
                  id: c.id,
                  name: c.name,
                  type: c.type,
                  readOnly: c.readOnly
                }));
              } catch (e) {
                return { error: e.toString() };
              }
            }

            /**
             * Opens a pre-filled event dialog for user review before saving.
             * Supports timed events and all-day events. Defaults to the first
             * writable calendar if no calendarId is specified.
             */
            function createEvent(title, startDate, endDate, location, description, calendarId, allDay) {
              if (!cal || !CalEvent) {
                return { error: "Calendar module not available" };
              }
              try {
                const win = Services.wm.getMostRecentWindow("mail:3pane");
                if (!win) {
                  return { error: "No Thunderbird window found" };
                }

                const startJs = new Date(startDate);
                if (isNaN(startJs.getTime())) {
                  return { error: `Invalid startDate: ${startDate}` };
                }

                let endJs = endDate ? new Date(endDate) : null;
                if (endDate && (!endJs || isNaN(endJs.getTime()))) {
                  return { error: `Invalid endDate: ${endDate}` };
                }

                const event = new CalEvent();
                event.title = title;

                if (allDay) {
                  const startDt = cal.createDateTime();
                  startDt.resetTo(startJs.getFullYear(), startJs.getMonth(), startJs.getDate(), 0, 0, 0, cal.dtz.floating);
                  startDt.isDate = true;
                  event.startDate = startDt;

                  const endDt = cal.createDateTime();
                  if (endJs) {
                    endDt.resetTo(endJs.getFullYear(), endJs.getMonth(), endJs.getDate(), 0, 0, 0, cal.dtz.floating);
                    endDt.isDate = true;
                    // iCal DTEND is exclusive - bump if same as or before start
                    if (endDt.compare(startDt) <= 0) {
                      endDt.day += 1;
                    }
                  } else {
                    endDt.resetTo(startJs.getFullYear(), startJs.getMonth(), startJs.getDate() + 1, 0, 0, 0, cal.dtz.floating);
                    endDt.isDate = true;
                  }
                  event.endDate = endDt;
                } else {
                  event.startDate = cal.dtz.jsDateToDateTime(startJs, cal.dtz.defaultTimezone);
                  if (endJs) {
                    event.endDate = cal.dtz.jsDateToDateTime(endJs, cal.dtz.defaultTimezone);
                  } else {
                    const defaultEnd = new Date(startJs.getTime() + 3600000);
                    event.endDate = cal.dtz.jsDateToDateTime(defaultEnd, cal.dtz.defaultTimezone);
                  }
                }

                if (location) event.setProperty("LOCATION", location);
                if (description) event.setProperty("DESCRIPTION", description);

                // Find target calendar
                const calendars = cal.manager.getCalendars();
                let targetCalendar = null;
                if (calendarId) {
                  targetCalendar = calendars.find(c => c.id === calendarId);
                  if (!targetCalendar) {
                    return { error: `Calendar not found: ${calendarId}` };
                  }
                  if (targetCalendar.readOnly) {
                    return { error: `Calendar is read-only: ${targetCalendar.name}` };
                  }
                } else {
                  targetCalendar = calendars.find(c => !c.readOnly);
                  if (!targetCalendar) {
                    return { error: "No writable calendar found" };
                  }
                }

                event.calendar = targetCalendar;

                const args = {
                  calendarEvent: event,
                  calendar: targetCalendar,
                  mode: "new",
                  inTab: false,
                  onOk(item, calendar) {
                    calendar.addItem(item);
                  },
                };

                win.openDialog(
                  "chrome://calendar/content/calendar-event-dialog.xhtml",
                  "_blank",
                  "centerscreen,chrome,titlebar,toolbar,resizable",
                  args
                );

                return { success: true, message: `Event dialog opened for "${title}" on calendar "${targetCalendar.name}"` };
              } catch (e) {
                return { error: e.toString() };
              }
            }

            function listFolders(accountId) {
              const results = [];

              function walkFolder(folder, accountKey, depth) {
                results.push({
                  name: folder.prettyName,
                  path: folder.URI,
                  accountId: accountKey,
                  totalMessages: folder.getTotalMessages(false),
                  unreadMessages: folder.getNumUnread(false),
                  depth
                });

                if (folder.hasSubFolders) {
                  for (const sub of folder.subFolders) {
                    walkFolder(sub, accountKey, depth + 1);
                  }
                }
              }

              for (const account of MailServices.accounts.accounts) {
                if (accountId && account.key !== accountId) continue;
                try {
                  const root = account.incomingServer.rootFolder;
                  if (root.hasSubFolders) {
                    for (const sub of root.subFolders) {
                      walkFolder(sub, account.key, 0);
                    }
                  }
                } catch {
                  // Skip inaccessible accounts
                }
              }

              return results;
            }

            const DEFAULT_LARGE_THRESHOLD = 10 * 1024 * 1024; // 10MB
            const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50MB

            /**
             * Sanitize a string for use as a filesystem path component.
             * Replaces characters unsafe for filesystems with underscores.
             */
            function sanitizePath(s) {
              let cleaned = (s || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "_";
              // Cap at 30 chars so directory names stay short and practical
              // while still being recognizable. Prefer a word boundary if possible.
              if (cleaned.length > 30) {
                const truncated = cleaned.substring(0, 30);
                const lastSpace = truncated.lastIndexOf(" ");
                cleaned = lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated;
              }
              return cleaned;
            }

            /**
             * Extract an email address from a string like "Name <email@example.com>".
             */
            function extractEmail(s) {
              const match = (s || "").match(/<([^>]+)>/);
              return match ? match[1].toLowerCase() : (s || "").trim().toLowerCase();
            }

            /**
             * Extract account email from a folder URI.
             * IMAP URIs look like: imap://user%40example.com@imap.example.com/INBOX
             * The user part is between :// and @ before the host.
             */
            function extractAccountFromURI(uri) {
              try {
                const match = uri.match(/:\/\/([^@]+)@/);
                if (match) {
                  return decodeURIComponent(match[1]);
                }
              } catch {
                // Fall through
              }
              return "local";
            }

            /**
             * Build the organized output directory for a message's attachments.
             * Path: /tmp/thunderbird-cli/<account>/<sender>/<subject>/
             */
            function buildAttachmentDir(folderPath, author, subject, inReplyTo) {
              const account = sanitizePath(extractAccountFromURI(folderPath));
              const sender = sanitizePath(extractEmail(author));
              const subjectPrefix = inReplyTo ? "thread|" : "";
              const subjectPart = sanitizePath(subjectPrefix + (subject || "no-subject"));

              const tmpDir = Cc["@mozilla.org/file/directory_service;1"]
                .getService(Ci.nsIProperties)
                .get("TmpD", Ci.nsIFile);
              tmpDir.append("thunderbird-cli");
              if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
              tmpDir.append(account);
              if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
              tmpDir.append(sender);
              if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
              tmpDir.append(subjectPart);
              if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
              return tmpDir;
            }

            function getMessage(messageId, folderPath, saveAttachments, forceLarge) {
              return new Promise((resolve) => {
                try {
                  const found = findMessage(messageId, folderPath);
                  if (found.error) {
                    resolve(found);
                    return;
                  }
                  const { msgHdr } = found;

                  const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
                    "resource:///modules/gloda/MimeMessage.sys.mjs"
                  );

                  MsgHdrToMimeMessage(msgHdr, null, async (aMsgHdr, aMimeMsg) => {
                    if (!aMimeMsg) {
                      resolve({ error: "Could not parse message" });
                      return;
                    }

                    // --- Content-ID mapping ---
                    // Build a map from content-id to attachment for inline detection.
                    const rawAttachments = aMimeMsg.allUserAttachments || [];
                    const cidToAttachment = new Map();
                    for (const att of rawAttachments) {
                      let cid = null;
                      if (att.headers) {
                        cid = att.headers["content-id"] || att.headers["Content-ID"] || null;
                        // Content-ID headers are wrapped in angle brackets: <cid-value>
                        if (Array.isArray(cid)) cid = cid[0];
                        if (cid) cid = cid.replace(/^<|>$/g, "");
                      }
                      if (cid) {
                        cidToAttachment.set(cid, att);
                      }
                    }

                    // --- Find HTML body for inline reference detection ---
                    let htmlBody = null;
                    function findHtmlPart(part) {
                      const ct = (part.contentType || part.type || "").split(";")[0].trim().toLowerCase();
                      if (ct === "text/html" && part.body) return part.body;
                      if (part.parts) {
                        for (const sub of part.parts) {
                          const result = findHtmlPart(sub);
                          if (result) return result;
                        }
                      }
                      return null;
                    }
                    htmlBody = findHtmlPart(aMimeMsg);

                    // --- Inline reference detection and numbering ---
                    // Inline attachments are numbered first (order of appearance in HTML),
                    // then remaining attachments are numbered sequentially after.
                    const inlineAttachments = new Set(); // Set of raw attachment objects
                    const inlineCidOrder = []; // Ordered list of { cid, att }
                    if (htmlBody && cidToAttachment.size > 0) {
                      // Find all cid: references in img src and other elements
                      const cidRegex = /(?:src|data|href)\s*=\s*["']cid:([^"']+)["']/gi;
                      let cidMatch;
                      const seenCids = new Set();
                      while ((cidMatch = cidRegex.exec(htmlBody)) !== null) {
                        const cid = cidMatch[1];
                        if (!seenCids.has(cid) && cidToAttachment.has(cid)) {
                          seenCids.add(cid);
                          const att = cidToAttachment.get(cid);
                          inlineAttachments.add(att);
                          inlineCidOrder.push({ cid, att });
                        }
                      }
                    }

                    // Assign reference numbers: inline first, then non-inline
                    let refNum = 1;
                    const attRefMap = new Map(); // att -> { referenceNumber, referenceTag, inline }
                    for (const { att } of inlineCidOrder) {
                      const ct = (att.contentType || "").toLowerCase();
                      const isImage = ct.startsWith("image/");
                      const tag = isImage ? `[Image #${refNum}]` : `[File #${refNum}]`;
                      attRefMap.set(att, { referenceNumber: refNum, referenceTag: tag, inline: true });
                      refNum++;
                    }
                    for (const att of rawAttachments) {
                      if (!inlineAttachments.has(att)) {
                        const ct = (att.contentType || "").toLowerCase();
                        const isImage = ct.startsWith("image/");
                        const tag = isImage ? `[Image #${refNum}]` : `[File #${refNum}]`;
                        attRefMap.set(att, { referenceNumber: refNum, referenceTag: tag, inline: false });
                        refNum++;
                      }
                    }

                    // --- Body extraction with inline reference replacement ---
                    // When inline attachments exist, we must use the HTML body so we can
                    // replace <img src="cid:..."> with [Image #N] markers before stripping.
                    // coerceBodyToPlaintext would silently drop those references.
                    let body = "";
                    let bodyIsHtml = false;
                    const hasInlineRefs = inlineCidOrder.length > 0;

                    if (hasInlineRefs && htmlBody) {
                      // Use HTML body so inline cid references can be replaced with markers
                      body = htmlBody;
                      bodyIsHtml = true;
                    } else {
                      try {
                        body = aMimeMsg.coerceBodyToPlaintext() || "";
                      } catch {
                        body = "";
                      }
                    }

                    if (!body) {
                      function findTextPart(part) {
                        const ct = (part.contentType || part.type || "").split(";")[0].trim().toLowerCase();
                        if (ct === "text/plain" && part.body) return { content: part.body, isHtml: false };
                        if (ct === "text/html" && part.body) return { content: part.body, isHtml: true };
                        if (part.parts) {
                          for (const sub of part.parts) {
                            const result = findTextPart(sub);
                            if (result) return result;
                          }
                        }
                        return null;
                      }
                      const foundPart = findTextPart(aMimeMsg);
                      if (foundPart) {
                        if (foundPart.isHtml) {
                          bodyIsHtml = true;
                          body = foundPart.content;
                        } else {
                          body = foundPart.content;
                        }
                      }
                    }

                    // If we have HTML body content, replace inline cid references
                    // with markers before stripping tags to plain text.
                    if (bodyIsHtml && body) {
                      // Replace <img src="cid:..."> tags with [Image #N] markers
                      for (const { cid, att } of inlineCidOrder) {
                        const ref = attRefMap.get(att);
                        if (ref) {
                          // Match img tags referencing this cid
                          const imgRegex = new RegExp(`<img[^>]*src=["']cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, "gi");
                          body = body.replace(imgRegex, ref.referenceTag);
                          // Also replace non-img cid references
                          const otherRegex = new RegExp(`(src|href|data)=["']cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, "gi");
                          body = body.replace(otherRegex, ref.referenceTag);
                        }
                      }

                      // Now strip HTML to plain text
                      body = body
                        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
                        .replace(/<[^>]+>/g, " ")
                        .replace(/&nbsp;/g, " ")
                        .replace(/&amp;/g, "&")
                        .replace(/&lt;/g, "<")
                        .replace(/&gt;/g, ">")
                        .replace(/&quot;/g, '"')
                        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
                        .replace(/\s+/g, " ")
                        .trim();
                    }
                    if (!body) body = "(Could not extract body text)";

                    // --- Attachment processing ---
                    const attachments = [];

                    // Check for In-Reply-To header for directory naming
                    let inReplyTo = null;
                    try {
                      // Try to get In-Reply-To from the MIME message headers
                      if (aMimeMsg.headers && aMimeMsg.headers["in-reply-to"]) {
                        inReplyTo = aMimeMsg.headers["in-reply-to"];
                        if (Array.isArray(inReplyTo)) inReplyTo = inReplyTo[0];
                      }
                    } catch {
                      // Not critical
                    }

                    if (saveAttachments && rawAttachments.length > 0) {
                      const subject = msgHdr.mime2DecodedSubject || msgHdr.subject || "";
                      const author = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
                      const tmpDir = buildAttachmentDir(folderPath, author, subject, inReplyTo);

                      for (const att of rawAttachments) {
                        const ref = attRefMap.get(att) || { referenceNumber: 0, referenceTag: "", inline: false };
                        const attInfo = {
                          name: att.name,
                          contentType: att.contentType,
                          size: att.size || 0,
                          referenceNumber: ref.referenceNumber,
                          referenceTag: ref.referenceTag,
                          inline: ref.inline,
                          filePath: null,
                          deferred: false
                        };

                        // Size-gated downloading: 10MB threshold unless forceLarge
                        if (attInfo.size > MAX_ATTACHMENT_SIZE) {
                          attInfo.error = "Exceeds 50MB hard size limit";
                          attInfo.deferred = true;
                          attachments.push(attInfo);
                          continue;
                        }

                        if (attInfo.size > DEFAULT_LARGE_THRESHOLD && !forceLarge) {
                          attInfo.deferred = true;
                          attInfo.hint = "Use --force-large to download attachments over 10MB";
                          attachments.push(attInfo);
                          continue;
                        }

                        try {
                          const data = await new Promise((res, rej) => {
                            const uri = Services.io.newURI(att.url);
                            NetUtil.asyncFetch(
                              { uri, loadUsingSystemPrincipal: true },
                              (inputStream, status) => {
                                if (!Components.isSuccessCode(status)) {
                                  rej(new Error(`Fetch failed: ${status}`));
                                  return;
                                }
                                const bis = Cc["@mozilla.org/binaryinputstream;1"]
                                  .createInstance(Ci.nsIBinaryInputStream);
                                bis.setInputStream(inputStream);
                                const chunks = [];
                                let avail;
                                while ((avail = bis.available()) > 0) {
                                  chunks.push(bis.readBytes(avail));
                                }
                                res(chunks.join(""));
                              }
                            );
                          });

                          // Name files as <N>-<original-name>
                          const fileName = `${ref.referenceNumber}-${att.name || "attachment"}`;
                          const outFile = tmpDir.clone();
                          outFile.append(fileName);
                          outFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644);

                          const fos = Cc["@mozilla.org/network/file-output-stream;1"]
                            .createInstance(Ci.nsIFileOutputStream);
                          fos.init(outFile, 0x02 | 0x08 | 0x20, 0o644, 0);
                          fos.write(data, data.length);
                          fos.close();

                          attInfo.filePath = outFile.path;
                          attInfo.size = data.length;
                        } catch (e) {
                          attInfo.error = `Save failed: ${e.message || e}`;
                        }

                        attachments.push(attInfo);
                      }
                    } else {
                      for (const att of rawAttachments) {
                        const ref = attRefMap.get(att) || { referenceNumber: 0, referenceTag: "", inline: false };
                        attachments.push({
                          name: att.name,
                          contentType: att.contentType,
                          size: att.size || 0,
                          referenceNumber: ref.referenceNumber,
                          referenceTag: ref.referenceTag,
                          inline: ref.inline,
                          filePath: null,
                          deferred: false
                        });
                      }
                    }

                    resolve({
                      id: msgHdr.messageId,
                      subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
                      author: msgHdr.mime2DecodedAuthor || msgHdr.author,
                      recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients,
                      ccList: msgHdr.ccList,
                      date: msgHdr.date ? new Date(msgHdr.date / 1000).toISOString() : null,
                      read: msgHdr.isRead,
                      flagged: msgHdr.isFlagged,
                      body,
                      bodyIsHtml,
                      attachments
                    });
                  }, true, { examineEncryptedParts: true });

                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

            /**
             * Opens a compose window with pre-filled fields.
             *
             * HTML body handling quirks:
             * 1. Strip newlines from HTML - Thunderbird adds <br> for each \n
             * 2. Encode non-ASCII as HTML entities - compose window has charset issues
             *    with emojis/unicode even with <meta charset="UTF-8">
             */
            function composeMail(to, subject, body, cc, bcc, isHtml, from, attachments) {
              try {
                const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
                  .getService(Ci.nsIMsgComposeService);

                const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
                  .createInstance(Ci.nsIMsgComposeParams);

                const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                  .createInstance(Ci.nsIMsgCompFields);

                composeFields.to = to || "";
                composeFields.cc = cc || "";
                composeFields.bcc = bcc || "";
                composeFields.subject = subject || "";

                const formatted = formatBodyHtml(body, isHtml);
                if (isHtml && formatted.includes('<html')) {
                  composeFields.body = formatted;
                } else {
                  composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${formatted}</body></html>`;
                }

                // Add file attachments
                const attResult = addAttachments(composeFields, attachments);

                msgComposeParams.type = Ci.nsIMsgCompType.New;
                msgComposeParams.format = Ci.nsIMsgCompFormat.HTML;
                msgComposeParams.composeFields = composeFields;

                const identityWarning = setComposeIdentity(msgComposeParams, from, null);

                msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);

                let msg = "Compose window opened";
                if (identityWarning) msg += ` (${identityWarning})`;
                if (attResult.failed.length > 0) {
                  msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
                }
                return { success: true, message: msg };
              } catch (e) {
                return { error: e.toString() };
              }
            }

            /**
             * Opens a reply compose window for a message with quoted original.
             *
             * Uses nsIMsgCompType.New to preserve our body content, then manually
             * builds the quoted original message text. Threading is maintained
             * via the References and In-Reply-To headers.
             */
            function replyToMessage(messageId, folderPath, body, replyAll, isHtml, to, cc, bcc, from, attachments) {
              return new Promise((resolve) => {
                try {
                  const found = findMessage(messageId, folderPath);
                  if (found.error) {
                    resolve(found);
                    return;
                  }
                  const { msgHdr, folder } = found;

                  // Fetch original message body for quoting
                  const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
                    "resource:///modules/gloda/MimeMessage.sys.mjs"
                  );

                  MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
                    try {
                      let originalBody = "";
                      if (aMimeMsg) {
                        try {
                          originalBody = aMimeMsg.coerceBodyToPlaintext() || "";
                        } catch {
                          originalBody = "";
                        }
                      }

                      const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
                        .getService(Ci.nsIMsgComposeService);

                      const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
                        .createInstance(Ci.nsIMsgComposeParams);

                      const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                        .createInstance(Ci.nsIMsgCompFields);

                      if (replyAll) {
                        composeFields.to = to || msgHdr.author;
                        // Combine original recipients and CC, filter out own address
                        // Split on commas not inside quotes to handle "Last, First" <email>
                        const splitAddresses = (s) => (s || "").match(/(?:[^,"]|"[^"]*")+/g) || [];
                        const extractEmail = (s) => (s.match(/<([^>]+)>/)?.[1] || s.trim()).toLowerCase();
                        // Get own email from the account identity for accurate self-filtering
                        const ownAccount = MailServices.accounts.findAccountForServer(folder.server);
                        const ownEmail = (ownAccount?.defaultIdentity?.email || "").toLowerCase();
                        const allRecipients = [
                          ...splitAddresses(msgHdr.recipients),
                          ...splitAddresses(msgHdr.ccList)
                        ]
                          .map(r => r.trim())
                          .filter(r => r && (!ownEmail || extractEmail(r) !== ownEmail));
                        // Deduplicate by email address
                        const seen = new Set();
                        const uniqueRecipients = allRecipients.filter(r => {
                          const email = extractEmail(r);
                          if (seen.has(email)) return false;
                          seen.add(email);
                          return true;
                        });
                        if (cc) {
                          composeFields.cc = cc;
                        } else if (uniqueRecipients.length > 0) {
                          composeFields.cc = uniqueRecipients.join(", ");
                        }
                      } else {
                        composeFields.to = to || msgHdr.author;
                        if (cc) composeFields.cc = cc;
                      }

                      composeFields.bcc = bcc || "";

                      const origSubject = msgHdr.mime2DecodedSubject || msgHdr.subject || "";
                      composeFields.subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;

                      // Threading headers
                      composeFields.references = `<${messageId}>`;
                      composeFields.setHeader("In-Reply-To", `<${messageId}>`);

                      // Build quoted text block using blockquote for proper Thunderbird rendering
                      const dateStr = msgHdr.date ? new Date(msgHdr.date / 1000).toLocaleString() : "";
                      const author = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
                      const quotedContent = escapeHtml(originalBody).replace(/\n/g, '<br>');
                      const quoteBlock = `<br><br>On ${dateStr}, ${escapeHtml(author)} wrote:<br><blockquote type="cite">${quotedContent}</blockquote>`;

                      composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${formatBodyHtml(body, isHtml)}${quoteBlock}</body></html>`;

                      // Add file attachments
                      const attResult = addAttachments(composeFields, attachments);

                      msgComposeParams.type = Ci.nsIMsgCompType.New;
                      msgComposeParams.format = Ci.nsIMsgCompFormat.HTML;
                      msgComposeParams.composeFields = composeFields;

                      const identityWarning = setComposeIdentity(msgComposeParams, from, folder.server);

                      msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);

                      let msg = "Reply window opened";
                      if (identityWarning) msg += ` (${identityWarning})`;
                      if (attResult.failed.length > 0) {
                        msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
                      }
                      resolve({ success: true, message: msg });
                    } catch (e) {
                      resolve({ error: e.toString() });
                    }
                  }, true, { examineEncryptedParts: true });

                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

            /**
             * Opens a forward compose window with attachments preserved.
             * Uses New type with manual forward quote to preserve both intro body and forwarded content.
             */
            function forwardMessage(messageId, folderPath, to, body, isHtml, cc, bcc, from, attachments) {
              return new Promise((resolve) => {
                try {
                  const found = findMessage(messageId, folderPath);
                  if (found.error) {
                    resolve(found);
                    return;
                  }
                  const { msgHdr, folder } = found;

                  // Get attachments and body from original message
                  const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
                    "resource:///modules/gloda/MimeMessage.sys.mjs"
                  );

                  MsgHdrToMimeMessage(msgHdr, null, (aMsgHdr, aMimeMsg) => {
                    try {
                      const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
                        .getService(Ci.nsIMsgComposeService);

                      const msgComposeParams = Cc["@mozilla.org/messengercompose/composeparams;1"]
                        .createInstance(Ci.nsIMsgComposeParams);

                      const composeFields = Cc["@mozilla.org/messengercompose/composefields;1"]
                        .createInstance(Ci.nsIMsgCompFields);

                      composeFields.to = to;
                      composeFields.cc = cc || "";
                      composeFields.bcc = bcc || "";

                      const origSubject = msgHdr.mime2DecodedSubject || msgHdr.subject || "";
                      composeFields.subject = origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`;

                      // Get original body
                      let originalBody = "";
                      if (aMimeMsg) {
                        try {
                          originalBody = aMimeMsg.coerceBodyToPlaintext() || "";
                        } catch {
                          originalBody = "";
                        }
                      }

                      // Build forward header block
                      const dateStr = msgHdr.date ? new Date(msgHdr.date / 1000).toLocaleString() : "";
                      const fwdAuthor = msgHdr.mime2DecodedAuthor || msgHdr.author || "";
                      const fwdSubject = msgHdr.mime2DecodedSubject || msgHdr.subject || "";
                      const fwdRecipients = msgHdr.mime2DecodedRecipients || msgHdr.recipients || "";
                      const escapedBody = escapeHtml(originalBody).replace(/\n/g, '<br>');

                      const forwardBlock = `-------- Forwarded Message --------<br>` +
                        `Subject: ${escapeHtml(fwdSubject)}<br>` +
                        `Date: ${dateStr}<br>` +
                        `From: ${escapeHtml(fwdAuthor)}<br>` +
                        `To: ${escapeHtml(fwdRecipients)}<br><br>` +
                        escapedBody;

                      // Combine intro body + forward block
                      const introHtml = body ? formatBodyHtml(body, isHtml) + '<br><br>' : "";

                      composeFields.body = `<html><head><meta charset="UTF-8"></head><body>${introHtml}${forwardBlock}</body></html>`;

                      // Copy attachments from original message
                      let origAttCount = 0;
                      if (aMimeMsg && aMimeMsg.allUserAttachments) {
                        for (const att of aMimeMsg.allUserAttachments) {
                          try {
                            const attachment = Cc["@mozilla.org/messengercompose/attachment;1"]
                              .createInstance(Ci.nsIMsgAttachment);
                            attachment.url = att.url;
                            attachment.name = att.name;
                            attachment.contentType = att.contentType;
                            composeFields.addAttachment(attachment);
                            origAttCount++;
                          } catch {
                            // Skip unreadable original attachments
                          }
                        }
                      }

                      // Add user-specified file attachments
                      const attResult = addAttachments(composeFields, attachments);

                      // Use New type - we build forward quote manually
                      msgComposeParams.type = Ci.nsIMsgCompType.New;
                      msgComposeParams.format = Ci.nsIMsgCompFormat.HTML;
                      msgComposeParams.composeFields = composeFields;

                      const identityWarning = setComposeIdentity(msgComposeParams, from, folder.server);

                      msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);

                      let msg = `Forward window opened with ${origAttCount + attResult.added} attachment(s)`;
                      if (identityWarning) msg += ` (${identityWarning})`;
                      if (attResult.failed.length > 0) {
                        msg += ` (failed to attach: ${attResult.failed.join(", ")})`;
                      }
                      resolve({ success: true, message: msg });
                    } catch (e) {
                      resolve({ error: e.toString() });
                    }
                  }, true, { examineEncryptedParts: true });

                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

            /**
             * Updates message state: read/flagged status, move to folder, or trash.
             * Operations applied in order: read, flagged, then move/trash.
             */
            function updateMessage(messageId, folderPath, opts) {
              return new Promise((resolve) => {
                try {
                  const found = findMessage(messageId, folderPath);
                  if (found.error) {
                    resolve(found);
                    return;
                  }
                  const { msgHdr, folder } = found;
                  const actions = [];

                  // Mark read/unread
                  if (opts.read !== undefined) {
                    folder.msgDatabase.markRead(msgHdr.messageKey, opts.read, null);
                    actions.push(opts.read ? "marked read" : "marked unread");
                  }

                  // Flag/unflag
                  if (opts.flagged !== undefined) {
                    folder.msgDatabase.markMarked(msgHdr.messageKey, opts.flagged, null);
                    actions.push(opts.flagged ? "flagged" : "unflagged");
                  }

                  // Move to folder or trash (mutually exclusive, trash takes precedence)
                  const targetURI = opts.trash ? null : opts.moveTo;
                  const moveToTrash = !!opts.trash;

                  if (moveToTrash || targetURI) {
                    let destFolder;

                    if (moveToTrash) {
                      // Find the Trash folder for this account
                      // Trash flag is nsMsgFolderFlags.Trash = 0x00000100
                      const root = folder.server.rootFolder;
                      destFolder = root.getFolderWithFlags(0x00000100);
                      if (!destFolder) {
                        resolve({ error: "Trash folder not found for this account" });
                        return;
                      }
                    } else {
                      destFolder = MailServices.folderLookup.getFolderForURL(targetURI);
                      if (!destFolder) {
                        resolve({ error: `Destination folder not found: ${targetURI}` });
                        return;
                      }
                    }

                    if (destFolder.URI === folder.URI) {
                      actions.push("already in destination folder");
                      resolve({ success: true, actions });
                      return;
                    }

                    // Create an nsIMutableArray with the message header
                    const msgArray = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
                    msgArray.appendElement(msgHdr);

                    const copyListener = {
                      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
                      OnStartCopy() {},
                      OnProgress() {},
                      SetMessageKey() {},
                      GetMessageId() { return null; },
                      OnStopCopy(statusCode) {
                        if (Components.isSuccessCode(statusCode)) {
                          actions.push(moveToTrash ? "trashed" : `moved to ${destFolder.prettyName}`);
                          resolve({ success: true, actions });
                        } else {
                          resolve({ error: `Move failed with status: ${statusCode}`, actions });
                        }
                      }
                    };

                    MailServices.copy.copyMessages(
                      folder,        // source folder
                      msgArray,      // messages
                      destFolder,    // destination
                      true,          // isMove
                      copyListener,  // listener
                      null,          // msgWindow
                      false          // allowUndo
                    );
                    return;
                  }

                  if (actions.length === 0) {
                    resolve({ success: true, actions: ["no changes requested"] });
                  } else {
                    resolve({ success: true, actions });
                  }
                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

            /**
             * Syncs a mail folder with its server.
             * Wraps folder.updateFolder in a Promise with nsIUrlListener
             * to detect completion, plus a timeout fallback.
             */
            function syncFolder(folderPath, timeoutMs) {
              return new Promise((resolve) => {
                try {
                  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
                  const folder = MailServices.folderLookup.getFolderForURL(folderPath);
                  if (!folder) {
                    resolve({ error: `Folder not found: ${folderPath}` });
                    return;
                  }

                  let settled = false;
                  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

                  const urlListener = {
                    QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
                    OnStartRunningUrl() {},
                    OnStopRunningUrl(_url, status) {
                      if (settled) return;
                      settled = true;
                      timer.cancel();
                      if (Components.isSuccessCode(status)) {
                        resolve({
                          folder: folderPath,
                          status: "synced",
                          messageCount: folder.getTotalMessages(false)
                        });
                      } else {
                        resolve({
                          folder: folderPath,
                          status: "error",
                          error: `Sync failed with status: ${status}`
                        });
                      }
                    }
                  };

                  timer.initWithCallback({
                    notify() {
                      if (settled) return;
                      settled = true;
                      resolve({ folder: folderPath, status: "timeout" });
                    }
                  }, timeout, Ci.nsITimer.TYPE_ONE_SHOT);

                  try {
                    folder.updateFolder(urlListener);
                  } catch (e) {
                    if (!settled) {
                      settled = true;
                      timer.cancel();
                      resolve({ error: `updateFolder failed: ${e}` });
                    }
                  }
                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

            async function callTool(name, args) {
              switch (name) {
                case "listAccounts":
                  return listAccounts();
                case "searchMessages":
                  return searchMessages(args.query || "", args.startDate, args.endDate, args.maxResults, args.sortOrder);
                case "getMessage":
                  return await getMessage(args.messageId, args.folderPath, args.saveAttachments, args.forceLarge);
                case "searchContacts":
                  return searchContacts(args.query || "");
                case "listCalendars":
                  return listCalendars();
                case "createEvent":
                  return createEvent(args.title, args.startDate, args.endDate, args.location, args.description, args.calendarId, args.allDay);
                case "sendMail":
                  return composeMail(args.to, args.subject, args.body, args.cc, args.bcc, args.isHtml, args.from, args.attachments);
                case "replyToMessage":
                  return await replyToMessage(args.messageId, args.folderPath, args.body, args.replyAll, args.isHtml, args.to, args.cc, args.bcc, args.from, args.attachments);
                case "forwardMessage":
                  return await forwardMessage(args.messageId, args.folderPath, args.to, args.body, args.isHtml, args.cc, args.bcc, args.from, args.attachments);
                case "listFolders":
                  return listFolders(args.accountId);
                case "updateMessage":
                  return await updateMessage(args.messageId, args.folderPath, args);
                case "syncFolder":
                  return await syncFolder(args.folderPath, args.timeoutMs);
                default:
                  throw new Error(`Unknown tool: ${name}`);
              }
            }

            const server = new HttpServer();

            server.registerPathHandler("/", (req, res) => {
              res.processAsync();

              if (req.method !== "POST") {
                res.setStatusLine("1.1", 405, "Method Not Allowed");
                res.write("POST only");
                res.finish();
                return;
              }

              let message;
              try {
                message = JSON.parse(readRequestBody(req));
              } catch {
                res.setStatusLine("1.1", 400, "Bad Request");
                res.write("Invalid JSON");
                res.finish();
                return;
              }

              const { id, method, params } = message;

              (async () => {
                try {
                  let result;
                  if (method === "listTools") {
                    result = { tools };
                  } else {
                    result = await callTool(method, params || {});
                  }
                  res.setStatusLine("1.1", 200, "OK");
                  // charset=utf-8 is critical for proper emoji handling in responses
                  res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                  res.write(sanitizeForJson(JSON.stringify({ jsonrpc: "2.0", id, result })));
                } catch (e) {
                  res.setStatusLine("1.1", 200, "OK");
                  res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                  res.write(sanitizeForJson(JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32000, message: e.toString() }
                  })));
                }
                res.finish();
              })();
            });

            server.start(API_PORT);
            console.log(`Thunderbird API server listening on port ${API_PORT}`);
            return { success: true, port: API_PORT };
          } catch (e) {
            console.error("Failed to start API server:", e);
            return { success: false, error: e.toString() };
          }
        }
      }
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    resProto.setSubstitution("thunderbird-api", null);
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }
};
