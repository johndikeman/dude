{
  description = "dude flake.nix with multi-repo compose orchestration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Your two repos to clone
    repo1 = {
      url = "github:username/repo1";
      flake = false;
    };
    repo2 = {
      url = "github:username/repo2";
      flake = false;
    };

    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      uv2nix,
      pyproject-nix,
      pyproject-build-systems,
      repo1,
      repo2,
      nix2container,
      ...
    }:
    let
      inherit (nixpkgs) lib;

      #############################################
      # CONFIGURATION - Edit these settings
      #############################################
      config = {
        # List of compose files to merge (in order of precedence)
        composeFiles = [
          "${repo1}/docker-compose.yml"
          "${repo2}/docker-compose.yml"
          # Add more repos here as needed
          # "${repo3}/docker-compose.yml"
        ];

        # Your app's service configuration
        appService = {
          enabled = true; # Set to false to exclude from compose entirely
          name = "dude";
          image = "dude:latest";
          ports = [ "8000:8000" ];
          environment = {
            PYTHONUNBUFFERED = "1";
            LOG_LEVEL = "info";
          };
          # Add any other docker-compose service config here
          restart = "unless-stopped";
        };

        # Container image configuration
        containerConfig = {
          name = "dude";
          tag = "latest";
          entrypoint = "dude"; # Binary name from your virtualenv (project.scripts in pyproject.toml)
          exposedPorts = [ "8000/tcp" ];
        };
      };
      #############################################

      # Load a uv workspace from a workspace root.
      workspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ./.; };

      # Create package overlay from workspace.
      overlay = workspace.mkPyprojectOverlay {
        sourcePreference = "wheel";
      };

      # Extend generated overlay with build fixups
      pyprojectOverrides = _final: _prev: {
        "google-crc32c" = _prev."google-crc32c".overrideAttrs (old: {
          nativeBuildInputs = old.nativeBuildInputs ++ [
            pkgs.python313Packages.setuptools
          ];
        });
      };

      pkgs = import nixpkgs {
        system = "x86_64-linux";
        overlays = [ nix2container.overlays.default ];
      };

      python = pkgs.python313;

      # Construct package set
      pythonSet =
        (pkgs.callPackage pyproject-nix.build.packages {
          inherit python;
        }).overrideScope
          (
            lib.composeManyExtensions [
              pyproject-build-systems.overlays.default
              overlay
              pyprojectOverrides
            ]
          );

      # Production virtualenv
      virtualenv = pythonSet.mkVirtualEnv "dude" workspace.deps.default;

      # Build Docker/Podman image using nix2container
      dudeImage = pkgs.nix2container.buildImage {
        name = config.containerConfig.name;
        tag = config.containerConfig.tag;

        copyToRoot = [ virtualenv ];

        config = {
          # Use shell form to allow arguments to be passed
          cmd = [ "${virtualenv}/bin/${config.containerConfig.entrypoint}" ];
          env = [
            "PYTHONUNBUFFERED=1"
            "PATH=${virtualenv}/bin:${pkgs.coreutils}/bin"
          ];
          exposedPorts = lib.listToAttrs (
            map (port: {
              name = port;
              value = { };
            }) config.containerConfig.exposedPorts
          );
        };

        layers = [
          (pkgs.nix2container.buildLayer {
            deps = [ python ];
          })
          (pkgs.nix2container.buildLayer {
            deps = [ virtualenv ];
          })
        ];
      };

      # Generate app service YAML if enabled
      appServiceYaml =
        if config.appService.enabled then
          ''
            ${config.appService.name}:
              image: ${config.appService.image}
              container_name: ${config.appService.name}
              ports:
                ${lib.concatMapStringsSep "\n    " (p: "- \"${p}\"") config.appService.ports}
              environment:
                ${lib.concatStringsSep "\n    " (
                  lib.mapAttrsToList (k: v: "- ${k}=${v}") config.appService.environment
                )}
              networks:
                - shared-network
              restart: ${config.appService.restart}
          ''
        else
          "";

      # Merge compose files - WITH app service
      mergedComposeWithApp =
        pkgs.runCommand "docker-compose-with-app.yml"
          {
            buildInputs = [ pkgs.yq-go ];
          }
          ''
            TEMP_DIR=$(mktemp -d)

            # Process each configured compose file
            ${lib.concatImapStringsSep "\n" (i: path: ''
              if [ -f "${path}" ]; then
                cp "${path}" "$TEMP_DIR/repo${toString i}.yml"
              else
                echo "services: {}" > "$TEMP_DIR/repo${toString i}.yml"
              fi
            '') config.composeFiles}

            # Create app service file
            cat > "$TEMP_DIR/app.yml" << 'EOF'
            version: '3.8'
            services:
              ${appServiceYaml}
            networks:
              shared-network:
                driver: bridge
            EOF

            # Build merge command
            MERGE_CMD="${pkgs.yq-go}/bin/yq eval-all '
              {
                \"version\": \"3.8\",
                \"services\": (
                  ${lib.concatImapStringsSep " *\n              " (
                    i: _: "(select(fileIndex == ${toString (i - 1)}).services // {})"
                  ) config.composeFiles}
                  ${
                    if config.appService.enabled then
                      " *\n              (select(fileIndex == ${toString (builtins.length config.composeFiles)}).services // {})"
                    else
                      ""
                  }
                ),
                \"networks\": (
                  ${lib.concatImapStringsSep " *\n              " (
                    i: _: "(select(fileIndex == ${toString (i - 1)}).networks // {})"
                  ) config.composeFiles}
                  ${
                    if config.appService.enabled then
                      " *\n              (select(fileIndex == ${toString (builtins.length config.composeFiles)}).networks // {})"
                    else
                      ""
                  }
                ),
                \"volumes\": (
                  ${lib.concatImapStringsSep " *\n              " (
                    i: _: "(select(fileIndex == ${toString (i - 1)}).volumes // {})"
                  ) config.composeFiles}
                  ${
                    if config.appService.enabled then
                      " *\n              (select(fileIndex == ${toString (builtins.length config.composeFiles)}).volumes // {})"
                    else
                      ""
                  }
                )
              }
            '"

            # Execute merge
            FILES="${
              lib.concatImapStringsSep " " (i: _: "\"$TEMP_DIR/repo${toString i}.yml\"") config.composeFiles
            }"
            ${
              if config.appService.enabled then
                ''
                  eval $MERGE_CMD $FILES "$TEMP_DIR/app.yml" > $out
                ''
              else
                ''
                  eval $MERGE_CMD $FILES > $out
                ''
            }

            rm -rf "$TEMP_DIR"
          '';

      # Merge compose files - WITHOUT app service (for dev workflow)
      mergedComposeWithoutApp =
        pkgs.runCommand "docker-compose-deps-only.yml"
          {
            buildInputs = [ pkgs.yq-go ];
          }
          ''
            TEMP_DIR=$(mktemp -d)

            # Process each configured compose file
            ${lib.concatImapStringsSep "\n" (i: path: ''
              if [ -f "${path}" ]; then
                cp "${path}" "$TEMP_DIR/repo${toString i}.yml"
              else
                echo "services: {}" > "$TEMP_DIR/repo${toString i}.yml"
              fi
            '') config.composeFiles}

            # Build merge command without app service
            MERGE_CMD="${pkgs.yq-go}/bin/yq eval-all '
              {
                \"version\": \"3.8\",
                \"services\": (
                  ${lib.concatImapStringsSep " *\n              " (
                    i: _: "(select(fileIndex == ${toString (i - 1)}).services // {})"
                  ) config.composeFiles}
                ),
                \"networks\": (
                  ${lib.concatImapStringsSep " *\n              " (
                    i: _: "(select(fileIndex == ${toString (i - 1)}).networks // {})"
                  ) config.composeFiles}
                ),
                \"volumes\": (
                  ${lib.concatImapStringsSep " *\n              " (
                    i: _: "(select(fileIndex == ${toString (i - 1)}).volumes // {})"
                  ) config.composeFiles}
                )
              }
            '"

            # Execute merge
            FILES="${
              lib.concatImapStringsSep " " (i: _: "\"$TEMP_DIR/repo${toString i}.yml\"") config.composeFiles
            }"
            eval $MERGE_CMD $FILES > $out

            rm -rf "$TEMP_DIR"
          '';

      # Scripts for full stack (with app)
      startAllScript = pkgs.writeShellScriptBin "start-all" ''
        set -e

        echo "Loading Podman image for ${config.appService.name}..."
        ${dudeImage.copyToDockerDaemon}

        echo "Starting all services (including ${config.appService.name}) with podman-compose..."
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithApp} up -d

        echo "All services started!"
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithApp} ps
      '';

      stopAllScript = pkgs.writeShellScriptBin "stop-all" ''
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithApp} down
      '';

      # Scripts for dependencies only (without app) - for dev workflow
      startDepsScript = pkgs.writeShellScriptBin "start-deps" ''
        set -e

        echo "Starting dependency services only (no ${config.appService.name})..."
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithoutApp} up -d

        echo "Dependency services started!"
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithoutApp} ps
        echo ""
        echo "✨ You can now run your app locally in the dev shell!"
      '';

      stopDepsScript = pkgs.writeShellScriptBin "stop-deps" ''
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithoutApp} down
      '';

      showComposeScript = pkgs.writeShellScriptBin "show-compose" ''
        echo "=== Full stack (with app) ==="
        cat ${mergedComposeWithApp}
        echo ""
        echo "=== Dependencies only (without app) ==="
        cat ${mergedComposeWithoutApp}
      '';

      logsAllScript = pkgs.writeShellScriptBin "logs-all" ''
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithApp} logs "$@"
      '';

      logsDepsScript = pkgs.writeShellScriptBin "logs-deps" ''
        ${pkgs.podman-compose}/bin/podman-compose -f ${mergedComposeWithoutApp} logs "$@"
      '';

      loadImageScript = pkgs.writeShellScriptBin "load-image" ''
        echo "Loading Podman image for ${config.appService.name}..."
        ${dudeImage.copyToDockerDaemon}
        echo "Image loaded successfully!"
        podman images | grep ${config.appService.name}
      '';

    in
    {
      packages.x86_64-linux = {
        default = virtualenv;
        image = dudeImage;
        compose-full = mergedComposeWithApp;
        compose-deps = mergedComposeWithoutApp;
      };

      apps.x86_64-linux = {
        default = {
          type = "app";
          program = "${virtualenv}/bin/dude";
        };

        # Full stack commands (app + dependencies)
        start = {
          type = "app";
          program = "${startAllScript}/bin/start-all";
        };
        stop = {
          type = "app";
          program = "${stopAllScript}/bin/stop-all";
        };
        logs = {
          type = "app";
          program = "${logsAllScript}/bin/logs-all";
        };

        # Dependencies-only commands (for dev workflow)
        start-deps = {
          type = "app";
          program = "${startDepsScript}/bin/start-deps";
        };
        stop-deps = {
          type = "app";
          program = "${stopDepsScript}/bin/stop-deps";
        };
        logs-deps = {
          type = "app";
          program = "${logsDepsScript}/bin/logs-deps";
        };

        # Utility commands
        show-compose = {
          type = "app";
          program = "${showComposeScript}/bin/show-compose";
        };
        load-image = {
          type = "app";
          program = "${loadImageScript}/bin/load-image";
        };
      };

      devShells.x86_64-linux = {
        default =
          let
            editableOverlay = workspace.mkEditablePyprojectOverlay {
              root = "$REPO_ROOT";
            };

            editablePythonSet = pythonSet.overrideScope (
              lib.composeManyExtensions [
                editableOverlay
                (final: prev: {
                  dude = prev.dude.overrideAttrs (old: {
                    src = lib.fileset.toSource {
                      root = old.src;
                      fileset = lib.fileset.unions [
                        (old.src + "/pyproject.toml")
                        (old.src + "/README.md")
                        (old.src + "/src")
                        (old.src + "/tests")
                        (old.src + "/scripts")
                      ];
                    };

                    nativeBuildInputs =
                      old.nativeBuildInputs
                      ++ final.resolveBuildSystem {
                        editables = [ ];
                      };
                  });
                })
              ]
            );

            devVirtualenv = editablePythonSet.mkVirtualEnv "dude" workspace.deps.all;

          in
          pkgs.mkShell {
            packages = [
              devVirtualenv
              pkgs.uv
              pkgs.nodejs_24
              pkgs.kubernetes-helm
              pkgs.podman
              pkgs.podman-compose
              pkgs.yq-go
            ];

            env = {
              UV_NO_SYNC = "1";
              UV_PYTHON = python.interpreter;
              UV_PYTHON_DOWNLOADS = "never";
            };

            shellHook = ''
              unset PYTHONPATH

              export REPO_ROOT=$(git rev-parse --show-toplevel)

              alias setup_openlit="helm repo add openlit https://openlit.github.io/helm/ && helm repo update && helm install openlit --set service.type=NodePort --set service.port=3000 openlit/openlit --kubeconfig=/etc/rancher/k3s/k3s.yaml"

              echo ""
              echo "🚀 Dude Development Environment"
              echo ""
              echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
              echo "📦 Development workflow (recommended):"
              echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
              echo "  nix run .#start-deps   - Start dependencies only"
              echo "  nix run                - Run your app locally"
              echo "  nix run .#stop-deps    - Stop dependencies"
              echo "  nix run .#logs-deps    - View dependency logs"
              echo ""
              echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
              echo "🐳 Full stack (app + dependencies in containers):"
              echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
              echo "  nix run .#start        - Start everything in containers"
              echo "  nix run .#stop         - Stop everything"
              echo "  nix run .#logs         - View all logs"
              echo ""
              echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
              echo "🔧 Utility commands:"
              echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
              echo "  nix run .#load-image   - Build and load dude image"
              echo "  nix run .#show-compose - View generated compose files"
              echo ""
              echo "📂 Cloned repos: ${
                lib.concatImapStringsSep ", " (i: _: "repo${toString i}") config.composeFiles
              }"
              echo ""
            '';
          };
      };
    };
}
