{
  description = "A self-improving AI agent based on pi-coding-agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      home-manager,
    }:
    let
      eachSystem = flake-utils.lib.eachDefaultSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          packages.default = pkgs.buildNpmPackage.override { nodejs = pkgs.nodejs_20; } {
            pname = "dude-agent";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-9cXPCdfMYNe8rpcTwO6GTfXYxjCt8MkfDZqDsKKnJKQ=";
            dontNpmBuild = true;
          };

          packages.skills = pkgs.stdenv.mkDerivation {
            pname = "dude-skills";
            version = "0.1.0";
            src = ./.pi/skills;
            installPhase = ''
              mkdir -p $out/skills
              cp -r * $out/skills/
            '';
          };

          devShells.default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_20
              git
              gh
              google-cloud-sdk
              _1password-cli
              chromium
            ];
            shellHook = ''
              export PATH=$PWD/node_modules/.bin:$PATH
              export PI_SKILLS=${self.packages.${system}.skills}/skills
              export WEB_BROWSE_BROWSER_BIN=${pkgs.chromium}/bin/chromium
            '';
          };
        }
      );
    in
    eachSystem
    // {
      # Home Manager Module for the Systemd Service
      homeManagerModules.dude-agent =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        {
          options.services.dude-agent = {
            enable = lib.mkEnableOption "Dude Agent Service";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.default;
            };
            workingDirectory = lib.mkOption {
              type = lib.types.str;
              default = "/home/john/dude";
            };
          };

          config = lib.mkIf config.services.dude-agent.enable {
            systemd.user.services.dude-agent = {
              Unit = {
                Description = "Dude Self-Improving AI Agent";
                After = [ "network.target" ];
              };
              Service = {
                Type = "simple";
                WorkingDirectory = config.services.dude-agent.workingDirectory;
                ExecStart = "${pkgs._1password-cli}/bin/op run --env-file ${config.services.dude-agent.package}/.opvars -- ${config.services.dude-agent.package}/bin/dude-agent";
                Restart = "always";
                RestartSec = "5s";
                Environment = [
                  "PI_SKILLS=${self.packages.${pkgs.system}.skills}/skills"
                  "WEB_BROWSE_BROWSER_BIN=${pkgs.chromium}/bin/chromium"
                  "PATH=${
                    lib.makeBinPath [
                      pkgs.git
                      pkgs.gh
                      pkgs.google-cloud-sdk
                      pkgs.nodejs_20
                      pkgs._1password-cli
                      pkgs.chromium
                    ]
                  }:${config.services.dude-agent.package}/lib/node_modules/dude-agent/node_modules/.bin:/usr/bin:/bin"
                ];
                EnvironmentFile = "-${config.services.dude-agent.workingDirectory}/.env";
              };
              Install.WantedBy = [ "default.target" ];
            };
          };
        };
    };
}
