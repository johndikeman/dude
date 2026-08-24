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

            # op run resolves the op:// refs in .opvars and injects them into
            # the child env; the inner bash then expands them at invocation.
            # (Expanding $VARS in the same command line as `op run` never
            # works - they are expanded before injection.)
            obLoginScript = pkgs.writeShellScript "dude-ob-login" ''
              exec ${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- \
                ${pkgs.bash}/bin/bash -c '
                  ${cfg.package}/lib/node_modules/dude-agent/node_modules/.bin/ob login \
                    --email="$OB_EMAIL" --password="$OB_PASSWORD"
                '
            '';
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

              piSessionDir = lib.mkOption {
                type = lib.types.str;
                default = "${cfg.configDirectory}/sessions/";
                description = "Path to the place where the pi session files are saved.";
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

              gitUserName = lib.mkOption {
                type = lib.types.str;
                default = "dudeagent";
                description = "Git user name used by the agent for commits.";
              };

              gitUserEmail = lib.mkOption {
                type = lib.types.str;
                default = "dude@johnf.art";
                description = "Git user email used by the agent for commits.";
              };
            };

            config = lib.mkIf cfg.enable {
              # Git identity for the agent.  Using mkDefault so consumers can
              # override in their own home.nix if desired.
              programs.git = {
                enable = lib.mkDefault true;
                settings.user = {
                  name = lib.mkDefault cfg.gitUserName;
                  email = lib.mkDefault cfg.gitUserEmail;
                };
              };

              # 0. Post-activation health check: verify long-running services
              # actually reach "active" state. Failing this aborts activation,
              # which deploy-rs detects and uses to magic-rollback the profile.
              home.activation.checkDudeServices = lib.hm.dag.entryAfter [ "reloadSystemd" ] (
                let
                  systemctl = "/usr/bin/systemctl --user";
                  servicesToCheck =
                    [
                      "dude-agent-watch.service"
                    ]
                    ++ lib.optionals (cfg.obsidianSync.enable && cfg.obsidianSync.separateService) [
                      "obsidian-sync.service"
                    ];
                  timeoutSecs = 90;
                in
                lib.optionalString (servicesToCheck != [ ]) ''
                  check_service() {
                    local svc="$1"
                    echo "Waiting for $svc to become active..."
                    for i in $(seq 1 ${toString (timeoutSecs / 5)}); do
                      if /usr/bin/systemctl --user is-active --quiet "$svc"; then
                        echo "$svc is active."
                        return 0
                      fi
                      sleep 5
                    done
                    echo "ERROR: $svc failed to become active within ${toString timeoutSecs}s" >&2
                    /usr/bin/systemctl --user status "$svc" --no-pager -l >&2 || true
                    return 1
                  }

                  # Reset any rate-limit/failed state so we get a clean start.
                  ${lib.concatMapStringsSep "\n" (svc: ''
                    ${systemctl} reset-failed ${svc} 2>/dev/null || true
                    ${systemctl} start ${svc}
                  '') servicesToCheck}

                  ${lib.concatMapStringsSep "\n" (svc: ''
                    check_service ${svc}
                  '') servicesToCheck}
                ''
              );

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
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.piSessionDir}"
                    "${obLoginScript}"
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
                    "PI_SESSION_DIR=${cfg.piSessionDir}"
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

              # 2. Dude Agent Watch Service (long-running Discord trigger listener)
              systemd.user.services.dude-agent-watch = {
                Unit = {
                  Description = "Dude Agent - Discord Trigger Watcher";
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
                  Type = "simple";
                  WorkingDirectory = cfg.workingDirectory;
                  ExecStartPre = [
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.configDirectory}"
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.workingDirectory}"
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.obsidianDir}"
                    "${pkgs.coreutils}/bin/mkdir -p ${cfg.piSessionDir}"
                    "${obLoginScript}"
                  ];
                  ExecStart = "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ${cfg.package}/bin/dude-agent";
                  Restart = "always";
                  RestartSec = "10s";
                  Environment = [
                    "DUDE_CONFIG_DIR=${cfg.configDirectory}"
                    "OBSIDIAN_DIR=${cfg.obsidianDir}"
                    "PI_SESSION_DIR=${cfg.piSessionDir}"
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
                Install = {
                  WantedBy = [ "default.target" ];
                };
              };

              # 3. Dude Agent Timer (schedules dude-agent runs)
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

              # 4. Dedicated continuous Obsidian sync service (when separateService = true)
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
                        "${obLoginScript}"
                        "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ob sync-setup --vault \"main\" --path ${cfg.obsidianSync.vaultPath}"
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
