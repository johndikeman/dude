{
  description = "A self-improving AI agent based on pi-coding-agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, home-manager }:
    let
      # Use a specific system for the home-manager module parts if needed, 
      # but flake-utils helps with the devShell.
      eachSystem = flake-utils.lib.eachDefaultSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          devShells.default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_20
              git
              gh
              google-cloud-sdk
            ];
            shellHook = ''
              export PATH=$PWD/node_modules/.bin:$PATH
            '';
          };
        }
      );
    in
    eachSystem // {
      # Home Manager Module for the Systemd Service
      homeManagerModules.dude-agent = { config, lib, pkgs, ... }: {
        options.services.dude-agent = {
          enable = lib.mkEnableOption "Dude Agent Service";
          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.nodejs_20;
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
              # Ensure we run from the absolute path of node
              ExecStart = "${config.services.dude-agent.package}/bin/node ${config.services.dude-agent.workingDirectory}/src/index.js";
              Restart = "always";
              RestartSec = "5s";
              Environment = [
                "PATH=${lib.makeBinPath [ pkgs.git pkgs.gh pkgs.google-cloud-sdk pkgs.nodejs_20 ]}:/usr/bin:/bin"
                "NODE_PATH=${config.services.dude-agent.workingDirectory}/node_modules"
              ];
              EnvironmentFile = "-${config.services.dude-agent.workingDirectory}/.env";
            };
            Install.WantedBy = [ "default.target" ];
          };
        };
      };
    };
}
