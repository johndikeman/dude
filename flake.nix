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
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
        in
        {
          packages.default = pkgs.buildNpmPackage.override { nodejs = pkgs.nodejs_24; } {
            pname = "dude-agent";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-YhS4frfvNACgr/FaeJdleVNyFyLXPSXQii4awG5fzuE=";
            npmDepsFetcherVersion = 2;
            dontNpmBuild = true;
            postInstall = ''
              cp .opvars $out/.opvars
            '';
          };

          packages.skills = pkgs.stdenv.mkDerivation {
            pname = "dude-skills";
            version = "0.1.0";
            src = ./.pi/skills;
            buildInputs = [
              pkgs.nodejs_24
              pkgs.coreutils
            ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            phases = [
              "unpackPhase"
              "buildPhase"
              "installPhase"
            ];
            buildPhase = ''
              # Install npm dependencies for skills that have package.json
              find $src -maxdepth 2 -name "package.json" -type f | while read pkg; do
                skill_dir=$(dirname "$pkg")
                if [ -f "$skill_dir/package-lock.json" ]; then
                  echo "Installing locked npm dependencies for $skill_dir..."
                  (cd "$skill_dir" && npm ci --prefer-offline --no-audit --progress=false 2>/dev/null || true)
                else
                  echo "Installing npm dependencies for $skill_dir (no lockfile)..."
                  (cd "$skill_dir" && npm install --prefer-offline --no-audit --progress=false 2>/dev/null || true)
                fi
              done
            '';
            installPhase = ''
              mkdir -p $out/skills
              cp -r * $out/skills/
            '';
          };

          devShells.default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_24
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
    // rec {
      # Home Manager Module for the Systemd Service and Timer
      homeManagerModules = {
        dude-agent =
          {
            config,
            lib,
            pkgs,
            ...
          }:
          let
            cfg = config.services.dude-agent;
          in
          {
            options.services.dude-agent = {
              enable = lib.mkEnableOption "Dude Agent Service";

              package = lib.mkOption {
                type = lib.types.package;
                default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
                description = "The dude-agent package to run.";
              };

              interval = lib.mkOption {
                type = lib.types.str;
                default = "00/6:00:00";
                description = ''
                  Systemd OnCalendar interval expression for running the agent.
                  Default is every 6 hours ("00/6:00:00").
                  Other valid formats include "*-*-* 00/6:00:00", "daily", "hourly", "*:0/30".
                '';
              };

              workingDirectory = lib.mkOption {
                type = lib.types.str;
                default = "${config.home.homeDirectory}/dude-workspace";
                description = "Working directory for agent workspace and repo clones.";
              };

              configDirectory = lib.mkOption {
                type = lib.types.str;
                default = "${config.home.homeDirectory}/.config/dude";
                description = "Configuration and log directory for dude agent.";
              };

              obsidianDir = lib.mkOption {
                type = lib.types.str;
                default = "${config.home.homeDirectory}/vault";
                description = "Path to the local Obsidian vault containing ai-tasks.md.";
              };

              opvarsFile = lib.mkOption {
                type = lib.types.str;
                default = "${cfg.package}/.opvars";
                description = "Path to the 1Password .opvars file.";
              };

              obsidianSync = {
                enable = lib.mkOption {
                  type = lib.types.bool;
                  default = true;
                  description = "Enable Obsidian headless synchronization for the vault.";
                };

                separateService = lib.mkOption {
                  type = lib.types.bool;
                  default = true;
                  description = ''
                    When true, runs Obsidian sync as a separate continuous systemd service (obsidian-sync.service).
                    When false, executes one-shot obsidian sync within the dude-agent service lifecycle (ExecStartPre and ExecStopPost).
                  '';
                };

                vaultPath = lib.mkOption {
                  type = lib.types.str;
                  default = cfg.obsidianDir;
                  description = "Path to the local Obsidian vault to sync.";
                };
              };
            };

            config = lib.mkIf cfg.enable {
              # 1. Dude Agent Service (runs a single agent task cycle)
              systemd.user.services.dude-agent = {
                Unit = {
                  Description = "Dude Self-Improving AI Agent";
                  After = [
                    "network.target"
                  ]
                  ++ lib.optional (
                    cfg.obsidianSync.enable && cfg.obsidianSync.separateService
                  ) "obsidian-sync.service";
                  Wants = lib.optional (
                    cfg.obsidianSync.enable && cfg.obsidianSync.separateService
                  ) "obsidian-sync.service";
                  StartLimitBurst = "5";
                  StartLimitIntervalSec = "120s";
                };
                Service = {
                  Type = "oneshot";
                  WorkingDirectory = cfg.workingDirectory;
                  ExecStartPre = [
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.configDirectory}"
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.workingDirectory}"
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.obsidianDir}"
                    "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- gh auth login --with-token $GH_TOKEN"
                    "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ob login --email=$OB_EMAIL --password=$OB_PW"
                  ]
                  ++
                    lib.optional (cfg.obsidianSync.enable && !cfg.obsidianSync.separateService)
                      "-${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ob sync --path ${cfg.obsidianSync.vaultPath}";

                  ExecStart = "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ${cfg.package}/bin/dude-agent --once";

                  ExecStopPost =
                    lib.optional (cfg.obsidianSync.enable && !cfg.obsidianSync.separateService)
                      "-${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ob sync --path ${cfg.obsidianSync.vaultPath}";

                  Environment = [
                    "DUDE_CONFIG_DIR=${cfg.configDirectory}"
                    "OBSIDIAN_DIR=${cfg.obsidianDir}"
                    "PI_SKILLS=${self.packages.${pkgs.stdenv.hostPlatform.system}.skills}/skills"
                    "WEB_BROWSE_BROWSER_BIN=${pkgs.chromium}/bin/chromium"
                    "PATH=${
                      lib.makeBinPath [
                        pkgs.git
                        pkgs.gh
                        pkgs.google-cloud-sdk
                        pkgs.nodejs_24
                        pkgs._1password-cli
                        pkgs.chromium
                        pkgs.coreutils
                      ]
                    }:${cfg.package}/lib/node_modules/dude-agent/node_modules/.bin:/usr/bin:/bin"
                  ];
                  EnvironmentFile = [
                    "-${cfg.workingDirectory}/.env"
                    "-${cfg.configDirectory}/.env"
                  ];
                };
              };

              # 2. Dude Agent Timer (schedules dude-agent runs)
              systemd.user.timers.dude-agent = {
                Unit = {
                  Description = "Dude Agent Scheduled Execution Timer";
                };
                Timer = {
                  OnCalendar = cfg.interval;
                  Persistent = true;
                };
                Install = {
                  WantedBy = [ "timers.target" ];
                };
              };

              # 3. Dedicated continuous Obsidian sync service (when separateService = true)
              systemd.user.services.obsidian-sync =
                lib.mkIf (cfg.obsidianSync.enable && cfg.obsidianSync.separateService)
                  {
                    Unit = {
                      Description = "Obsidian Continuous Headless Sync";
                      After = [ "network.target" ];
                      StartLimitBurst = "5";
                      StartLimitIntervalSec = "120s";
                    };
                    Service = {
                      Type = "simple";
                      ExecStartPre = [
                        "${pkgs.coreutils}/bin/mkdir -p ${cfg.obsidianSync.vaultPath}"
                        "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ob login --email=$OB_EMAIL --password=$OB_PW"
                      ];
                      ExecStart = "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ob sync --continuous --path ${cfg.obsidianSync.vaultPath}";
                      Restart = "always";
                      RestartSec = "10s";
                      Environment = [
                        "PATH=${
                          lib.makeBinPath [
                            pkgs.nodejs_24
                            pkgs._1password-cli
                            pkgs.coreutils
                          ]
                        }:${cfg.package}/lib/node_modules/dude-agent/node_modules/.bin:/usr/bin:/bin"
                      ];
                      EnvironmentFile = [
                        "-${cfg.workingDirectory}/.env"
                        "-${cfg.configDirectory}/.env"
                      ];
                    };
                    Install = {
                      WantedBy = [ "default.target" ];
                    };
                  };
            };
          };

        default = homeManagerModules.dude-agent;
      };
    };
}
