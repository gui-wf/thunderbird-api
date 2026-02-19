pub mod commands;
pub mod format;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "thunderbird-cli",
    about = "Command-line interface for Thunderbird email",
    version
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// List email accounts and identities
    Accounts,

    /// Search messages by subject, sender, or recipient
    Search {
        /// Search query
        query: String,

        /// Filter by start date (ISO 8601)
        #[arg(long)]
        start_date: Option<String>,

        /// Filter by end date (ISO 8601)
        #[arg(long)]
        end_date: Option<String>,

        /// Max results (default: 20)
        #[arg(long)]
        max: Option<usize>,

        /// Sort order (asc or desc, default: desc)
        #[arg(long)]
        sort: Option<String>,
    },

    /// Read a full email message
    Get {
        /// Message ID (RFC 2822 Message-ID header)
        message_id: String,

        /// Folder path
        folder_path: String,

        /// Save attachments to temp files
        #[arg(long)]
        save_attachments: bool,
    },

    /// List all mail folders
    Folders {
        /// Filter to a specific account
        #[arg(long)]
        account: Option<String>,
    },

    /// Update message state (read/unread, flag/unflag, move, trash)
    Update {
        /// Message ID (RFC 2822 Message-ID header)
        message_id: String,

        /// Folder path
        folder_path: String,

        /// Mark as read
        #[arg(long)]
        read: bool,

        /// Mark as unread
        #[arg(long)]
        unread: bool,

        /// Mark as flagged
        #[arg(long)]
        flag: bool,

        /// Remove flag
        #[arg(long)]
        unflag: bool,

        /// Move to folder URI
        #[arg(long)]
        move_to: Option<String>,

        /// Move to trash
        #[arg(long)]
        trash: bool,
    },

    /// Open compose window with pre-filled content
    Send {
        /// Recipient (required)
        #[arg(long)]
        to: String,

        /// Subject line
        #[arg(long)]
        subject: Option<String>,

        /// Message body
        #[arg(long)]
        body: Option<String>,

        /// CC recipients
        #[arg(long)]
        cc: Option<String>,

        /// BCC recipients
        #[arg(long)]
        bcc: Option<String>,

        /// Sender identity
        #[arg(long)]
        from: Option<String>,

        /// Body is HTML
        #[arg(long)]
        html: bool,
    },

    /// Reply to a message
    Reply {
        /// Message ID (RFC 2822 Message-ID header)
        message_id: String,

        /// Folder path
        folder_path: String,

        /// Reply body (required)
        #[arg(long)]
        body: String,

        /// Reply to all recipients
        #[arg(long)]
        reply_all: bool,

        /// Body is HTML
        #[arg(long)]
        html: bool,

        /// Override recipient
        #[arg(long)]
        to: Option<String>,

        /// CC recipients
        #[arg(long)]
        cc: Option<String>,

        /// Sender identity
        #[arg(long)]
        from: Option<String>,
    },

    /// Forward a message
    Forward {
        /// Message ID (RFC 2822 Message-ID header)
        message_id: String,

        /// Folder path
        folder_path: String,

        /// Recipient (required)
        #[arg(long)]
        to: String,

        /// Additional body text
        #[arg(long)]
        body: Option<String>,

        /// Body is HTML
        #[arg(long)]
        html: bool,

        /// CC recipients
        #[arg(long)]
        cc: Option<String>,

        /// Sender identity
        #[arg(long)]
        from: Option<String>,
    },

    /// Search contacts
    Contacts {
        /// Search query
        query: String,
    },

    /// List calendars
    Calendars,
}
