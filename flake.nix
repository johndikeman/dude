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
          browserEnv = [
            "FONTCONFIG_FILE=${self.packages.${pkgs.stdenv.hostPlatform.system}.browser-env}/fonts.conf"
          ];
        in
        {
          # pi-gemini-batch is packaged separately because a github: dependency
          # in package-lock.json makes fetchNpmDeps panic ("non-git dependencies
          # should have associated integrity"). We build it here from a pinned
          # github revision and splice it into dude-agent's node_modules below.
          packages.pi-gemini-batch = pkgs.buildNpmPackage.override { nodejs = pkgs.nodejs_24; } {
            pname = "pi-gemini-batch";
            version = "0.1.0";
            src = pkgs.fetchFromGitHub {
              owner = "dudeagent";
              repo = "pi-gemini-batch";
              rev = "b78fe1351a42601c5f316f16c5ed61d3a2ca8a23";
              hash = "sha256-1ATJgHLX+a5ME2R2nguC9U8YIck7e8xHVyxPlVS0SM0=";
            };
            npmDepsHash = "sha256-2NmNOJiquUueqZu1JTODHTGfPcxzguVS5kopDwV7sjM=";
            npmDepsFetcherVersion = 2;
            dontNpmBuild = true;
          };

          packages.default = pkgs.buildNpmPackage.override { nodejs = pkgs.nodejs_24; } {
            pname = "dude-agent";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-+7/Mc7nGnAZvOJ6TJaL0GACuDPWlno4AQwzAWNIaY8Y=";
            npmDepsFetcherVersion = 2;
            dontNpmBuild = true;
            postInstall = ''
              cp .opvars $out/.opvars
              mkdir -p $out/lib/node_modules/dude-agent/node_modules
              ln -sfn ${self.packages.${pkgs.stdenv.hostPlatform.system}.pi-gemini-batch}/lib/node_modules/pi-gemini-batch \
                $out/lib/node_modules/dude-agent/node_modules/pi-gemini-batch
              cp -r wait-functions $out/wait-functions
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

          # Chromium needs a fontconfig config + at least one font, otherwise its
          # renderer aborts in Skia (SkFontMgr_FontConfigInterface "Not implemented")
          # on any real page. On non-NixOS hosts there is no /etc/fonts, so we ship
          # our own fonts.conf and point FONTCONFIG_FILE at it.
          packages.browser-env = pkgs.runCommand "browser-env" { } ''
            mkdir -p $out
            cat > $out/fonts.conf <<EOF
            <?xml version="1.0"?>
            <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
            <fontconfig>
              <dir>${pkgs.dejavu_fonts}/share/fonts</dir>
              <dir>${pkgs.noto-fonts}/share/fonts</dir>
              <cachedir>/tmp/fontconfig-cache</cachedir>
            </fontconfig>
            EOF
          '';

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
            inherit browserEnv;
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
              # Nuke any stale token so ob login performs a fresh authentication
              # regardless of whether op:// injection hiccups or the cached
              # token has silently expired on the server side.
              AUTH_TOKEN_FILE="${config.home.homeDirectory}/.config/obsidian-headless/auth_token"
              rm -f "$AUTH_TOKEN_FILE"

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

              # internal: shared environment list for all dude-agent invocations
              dudeServiceEnv = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                internal = true;
                default = [ ];
                description = ''
                  Shared environment for dude-agent, dude-wait and purpose services.
                '';
              };

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

              waitTimer = {
                enable = lib.mkOption {
                  type = lib.types.bool;
                  default = false;
                  description = ''
                    Enable the dude-wait service + timer. Rather than giving every
                    agent purpose its own dumb schedule, this single frequently-
                    running timer checks all wait functions and invokes the
                    matching agent purpose when one fires.'';
                };
                interval = lib.mkOption {
                  type = lib.types.str;
                  default = "hourly";
                  description = ''
                    Systemd OnCalendar interval for checking the wait functions.
                    Default is hourly; can run more frequently if needed.'';
                };
                functionsDir = lib.mkOption {
                  type = lib.types.nullOr lib.types.path;
                  default = null;
                  description = ''
                    Directory of wait-function nodejs files (named for the agent
                    purpose they invoke). Defaults to the package's bundled
                    wait-functions directory.'';
                };
                stateFile = lib.mkOption {
                  type = lib.types.str;
                  default = "${cfg.configDirectory}/wait-state.json";
                  description = "Cache file for wait-function state.";
                };
              };

              purposes = lib.mkOption {
                type = lib.types.attrsOf (lib.types.submodule {
                  options = {
                    interval = lib.mkOption {
                      type = lib.types.str;
                      description = ''
                        Systemd OnCalendar interval for running this purpose,
                        e.g. "*-*-* 00/12:00:00" for every 12 hours.'';
                    };
                    environmentFile = lib.mkOption {
                      type = lib.types.nullOr lib.types.path;
                      default = null;
                      description = ''
                        Extra environment file required for this purpose (e.g. 1p
                        service account vars). Checked non-fatally.'';
                    };
                  };
                });
                default = { };
                description = ''
                  Special-purpose agent runs, each as dude-agent --once
                  --purpose <name> on its own schedule. Purpose definitions
                  (prompt + skills) live in the dude-agent package under
                  src/purposes/<name>.js.'';
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
              # Optional runtimeMaxSec for obsidian-sync (kept for backward compatibility but now hardcoded)
              runtimeMaxSec = lib.mkOption {
                type = lib.types.str;
                default = "30m";
                description = ''
                  Maximum continuous runtime before systemd terminates and restarts
                  the obsidian-sync service.  This forces a token refresh via
                  ExecStartPre even when obsidian-headless would otherwise loop
                  forever on a stale auth token.
                '';
              };
            };

            config = lib.mkIf cfg.enable (lib.mkMerge [
            {
              # shared environment for every dude-agent invocation (main, wait
              # runner, and per-purpose services)
              services.dude-agent.dudeServiceEnv = [
                "DUDE_CONFIG_DIR=${cfg.configDirectory}"
                "DUDE_WORKING_DIR=${cfg.workingDirectory}"
                "OBSIDIAN_DIR=${cfg.obsidianDir}"
                "PI_SESSION_DIR=${cfg.piSessionDir}"
                "PI_SKILLS=${self.packages.${pkgs.stdenv.hostPlatform.system}.skills}/skills"
                "WEB_BROWSE_BROWSER_BIN=${pkgs.chromium}/bin/chromium"
                "FONTCONFIG_FILE=${self.packages.${pkgs.stdenv.hostPlatform.system}.browser-env}/fonts.conf"
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
              # Git identity for the agent.  Using mkDefault so consumers can
              # override in their own home.nix if desired.
              programs.git = {
                enable = lib.mkDefault true;
                settings.user = {
                  name = lib.mkDefault cfg.gitUserName;
                  email = lib.mkDefault cfg.gitUserEmail;
                };
                settings.credential = {
                  helper = lib.mkDefault "!gh auth git-credential";
                };
              };

              # 0. Post-activation health check: verify long-running services
              # actually reach "active" state. Failing this aborts activation,
              # which deploy-rs detects and uses to magic-rollback the profile.
              home.activation.checkDudeServices = lib.hm.dag.entryAfter [ "reloadSystemd" ] (
                let
                  systemctl = "/usr/bin/systemctl --user";
                  servicesToCheck = [
                    "dude-agent-watch.service"
                  ]
                  ++ lib.optionals (cfg.obsidianSync.enable && cfg.obsidianSync.separateService) [
                    "obsidian-sync.service"
                  ];
                  timeoutSecs = 300;
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

                  Environment = cfg.dudeServiceEnv;
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
                  Environment = cfg.dudeServiceEnv;
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

              # 3b. dude-wait: event-driven invocation of agent purposes.
              # one frequently-running timer checks all wait functions and
              # starts dude-agent --once --purpose <name> when one fires.
              systemd.user.services.dude-wait =
                lib.mkIf cfg.waitTimer.enable
                  {
                    Unit = {
                      Description = "Dude Agent Wait Function Checker";
                      After = [ "network.target" ];
                      StartLimitBurst = "5";
                      StartLimitIntervalSec = "120s";
                    };
                    Service = {
                      Type = "oneshot";
                      WorkingDirectory = cfg.workingDirectory;
                      ExecStart =
                        let
                          args = [
                            "--functions-dir=${
                            if cfg.waitTimer.functionsDir != null
                            then cfg.waitTimer.functionsDir
                            else "${cfg.package}/wait-functions"
                          }"
                            "--state-file=${cfg.waitTimer.stateFile}"
                          ];
                        in
                        "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ${cfg.package}/bin/dude-wait ${lib.concatStringsSep " " args}";
                      Environment = cfg.dudeServiceEnv;
                      EnvironmentFile = [
                        "-${cfg.workingDirectory}/.env"
                        "-${cfg.configDirectory}/.env"
                      ];
                    };
                  };

              systemd.user.timers.dude-wait =
                lib.mkIf cfg.waitTimer.enable
                  {
                    Unit = {
                      Description = "Dude Agent Wait Function Checker Timer";
                    };
                    Timer = {
                      OnCalendar = cfg.waitTimer.interval;
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
            }

            # 3c. per-purpose oneshot services + timers (separate merge member
            # so dynamic unit names merge with the static defs above). each
            # purpose is defined in the package under src/purposes/<name>.js
            # and runs dude-agent --once --purpose <name> on its own schedule.
            (lib.mkIf (cfg.purposes != { }) {
            systemd.user.services =
                (lib.mapAttrs'
                  (purposeName: purposeCfg: {
                    name = "dude-agent-${purposeName}";
                    value = {
                      Unit = {
                        Description = "Dude Agent (purpose: ${purposeName})";
                        After = [ "network.target" ];
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
                        ]
                        ++ lib.optional (purposeCfg.environmentFile != null)
                          "${pkgs.bash}/bin/bash -c 'test -f ${purposeCfg.environmentFile}'";
                        ExecStart =
                          (if purposeCfg.environmentFile != null then
                            "${pkgs._1password-cli}/bin/op run --env-file ${purposeCfg.environmentFile} -- ${cfg.package}/bin/dude-agent --once --purpose ${purposeName}"
                          else
                            "${pkgs._1password-cli}/bin/op run --env-file ${cfg.opvarsFile} -- ${cfg.package}/bin/dude-agent --once --purpose ${purposeName}");
                        Environment = cfg.dudeServiceEnv;
                        EnvironmentFile = [
                          "-${cfg.workingDirectory}/.env"
                          "-${cfg.configDirectory}/.env"
                        ];
                      };
                    };
                  })
                cfg.purposes);

              systemd.user.timers =
                (lib.mapAttrs'
                  (purposeName: purposeCfg: {
                    name = "dude-agent-${purposeName}";
                    value = {
                      Unit = {
                        Description = "Dude Agent (purpose: ${purposeName}) Timer";
                      };
                      Timer = {
                        OnCalendar = purposeCfg.interval;
                        Persistent = true;
                      };
                      Install = {
                        WantedBy = [ "timers.target" ];
                      };
                    };
                  })
                cfg.purposes);
            })

            ]);
          };

        default = homeManagerModules.dude-agent;
      };
    };
}
