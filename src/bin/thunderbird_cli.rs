use clap::Parser;
use std::process;

fn main() {
    let cli = thunderbird_api::cli::Cli::parse();
    if let Err(e) = thunderbird_api::cli::commands::run(cli) {
        eprintln!("Error: {}", e);
        process::exit(1);
    }
}
