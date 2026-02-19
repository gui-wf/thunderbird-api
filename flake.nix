{
  description = "MCP server for Thunderbird - AI assistant access to email, contacts, and calendars";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # The MCP bridge only uses Node.js built-ins (http, readline).
        # No npm install needed.
        thunderbird-api = pkgs.stdenvNoCC.mkDerivation {
          pname = "thunderbird-api";
          version = "0.2.0";
          src = ./.;

          dontBuild = true;
          dontConfigure = true;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/{bin,lib/thunderbird-api}

            # Install the bridge script
            cp mcp-bridge.cjs $out/lib/thunderbird-api/

            # Create wrapper that runs the bridge with node
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/thunderbird-api \
              --add-flags "$out/lib/thunderbird-api/mcp-bridge.cjs"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "MCP bridge for Thunderbird email";
            license = licenses.mit;
            mainProgram = "thunderbird-api";
          };
        };

        # CLI tool - same Node.js built-ins, no npm deps
        thunderbird-cli = pkgs.stdenvNoCC.mkDerivation {
          pname = "thunderbird-cli";
          version = "0.2.0";
          src = ./.;

          dontBuild = true;
          dontConfigure = true;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/{bin,lib/thunderbird-cli}

            cp thunderbird-cli.cjs $out/lib/thunderbird-cli/

            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/thunderbird-cli \
              --add-flags "$out/lib/thunderbird-cli/thunderbird-cli.cjs"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Command-line interface for Thunderbird email";
            license = licenses.mit;
            mainProgram = "thunderbird-cli";
          };
        };

        # Build the Thunderbird extension XPI
        thunderbird-api-extension = pkgs.stdenvNoCC.mkDerivation {
          pname = "thunderbird-api-extension";
          version = "0.2.0";
          src = ./extension;

          dontBuild = true;
          dontConfigure = true;

          nativeBuildInputs = [ pkgs.zip ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out
            zip -r $out/thunderbird-api.xpi . -x "*.DS_Store" -x "*.git*"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Thunderbird API extension (XPI)";
            license = licenses.mit;
          };
        };
      in
      {
        packages = {
          default = thunderbird-api;
          cli = thunderbird-cli;
          extension = thunderbird-api-extension;
        };

        apps = {
          default = {
            type = "app";
            program = "${thunderbird-api}/bin/thunderbird-api";
          };
          cli = {
            type = "app";
            program = "${thunderbird-cli}/bin/thunderbird-cli";
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            zip
            curl
            jq
          ];
        };
      }
    );
}
