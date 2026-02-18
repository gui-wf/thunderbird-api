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
        thunderbird-mcp = pkgs.stdenvNoCC.mkDerivation {
          pname = "thunderbird-mcp";
          version = "0.2.0";
          src = ./.;

          dontBuild = true;
          dontConfigure = true;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/{bin,lib/thunderbird-mcp}

            # Install the bridge script
            cp mcp-bridge.cjs $out/lib/thunderbird-mcp/

            # Create wrapper that runs the bridge with node
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/thunderbird-mcp \
              --add-flags "$out/lib/thunderbird-mcp/mcp-bridge.cjs"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "MCP bridge for Thunderbird email";
            license = licenses.mit;
            mainProgram = "thunderbird-mcp";
          };
        };

        # Build the Thunderbird extension XPI
        thunderbird-mcp-extension = pkgs.stdenvNoCC.mkDerivation {
          pname = "thunderbird-mcp-extension";
          version = "0.2.0";
          src = ./extension;

          dontBuild = true;
          dontConfigure = true;

          nativeBuildInputs = [ pkgs.zip ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out
            zip -r $out/thunderbird-mcp.xpi . -x "*.DS_Store" -x "*.git*"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Thunderbird MCP extension (XPI)";
            license = licenses.mit;
          };
        };
      in
      {
        packages = {
          default = thunderbird-mcp;
          extension = thunderbird-mcp-extension;
        };

        apps.default = {
          type = "app";
          program = "${thunderbird-mcp}/bin/thunderbird-mcp";
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
