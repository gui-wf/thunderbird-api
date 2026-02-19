{
  description = "MCP server and CLI for Thunderbird - AI assistant access to email, contacts, and calendars";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          thunderbird-api = pkgs.rustPlatform.buildRustPackage {
            pname = "thunderbird-api";
            version = "0.3.0";
            src = pkgs.lib.cleanSourceWith {
              src = ./.;
              filter =
                path: type:
                pkgs.lib.cleanSourceFilter path type && !(builtins.baseNameOf path == "target");
            };
            cargoLock.lockFile = ./Cargo.lock;
            meta = with pkgs.lib; {
              description = "MCP bridge and CLI for Thunderbird email";
              license = licenses.mit;
              mainProgram = "thunderbird-api";
            };
          };

          thunderbird-api-extension = pkgs.stdenvNoCC.mkDerivation {
            pname = "thunderbird-api-extension";
            version = "0.3.0";
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
          default = thunderbird-api;
          cli = thunderbird-api;
          extension = thunderbird-api-extension;
        }
      );

      apps = forAllSystems (
        system:
        let
          pkg = self.packages.${system}.default;
        in
        {
          default = {
            type = "app";
            program = "${pkg}/bin/thunderbird-api";
          };
          cli = {
            type = "app";
            program = "${pkg}/bin/thunderbird-cli";
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              rustc
              cargo
              rust-analyzer
              clippy
              rustfmt
              zip
              curl
              jq
            ];
          };
        }
      );
    };
}
