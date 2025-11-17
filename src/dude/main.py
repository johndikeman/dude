"""
Dude AI Agent CLI - Enhanced Logging Version
A friendly AI assistant with beautiful, informative console output.
"""

import logging
import sys
import asyncio
import uuid
from datetime import datetime

from google.genai import types
from google.adk.runners import Runner
from google.adk.sessions import DatabaseSessionService

from dude.agents.orchestrator import Orchestrator
from dude.agents import planner, coder


# Color codes for terminal output
class Colors:
    """ANSI color codes for terminal output"""

    CYAN = "\033[96m"
    BLUE = "\033[94m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    MAGENTA = "\033[95m"
    GRAY = "\033[90m"
    ENDC = "\033[0m"
    BOLD = "\033[1m"


# Emoji icons for different log levels
ICONS = {
    "INFO": "ℹ️ ",
    "SUCCESS": "✅",
    "ERROR": "❌",
    "WARNING": "⚠️ ",
    "DEBUG": "🐛",
    "START": "🚀",
    "FINISH": "🏁",
    "SHUTDOWN": "👋",
}


def print_banner():
    """Display a beautiful startup banner"""
    banner = f"""
{Colors.CYAN}{Colors.BOLD}
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║       dude🤖                                                  ║
║                                                               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
{Colors.ENDC}
"""
    print(banner)


def print_user_message(text):
    """Print user-facing messages with clean formatting"""
    print(f"{Colors.GREEN}{text}{Colors.ENDC}")


def print_error(text):
    """Print error messages with consistent formatting"""
    print(f"{Colors.RED}{ICONS['ERROR']} {text}{Colors.ENDC}")


def print_success(text):
    """Print success messages with consistent formatting"""
    print(f"{Colors.GREEN}{ICONS['SUCCESS']} {text}{Colors.ENDC}")


class ColoredFormatter(logging.Formatter):
    """Custom formatter with colors and emojis"""

    COLOR_MAP = {
        logging.DEBUG: Colors.GRAY,
        logging.INFO: Colors.BLUE,
        logging.WARNING: Colors.YELLOW,
        logging.ERROR: Colors.RED,
        logging.CRITICAL: Colors.RED + Colors.BOLD,
    }

    def format(self, record):
        """Format log record with colors and simplified output"""
        # Add emoji based on log level
        if record.levelno == logging.INFO:
            record.levelname = f"{ICONS['INFO']} INFO"
        elif record.levelno == logging.DEBUG:
            record.levelname = f"{ICONS['DEBUG']} DEBUG"
        elif record.levelno == logging.WARNING:
            record.levelname = f"{ICONS['WARNING']} WARN"
        elif record.levelno == logging.ERROR:
            record.levelname = f"{ICONS['ERROR']} ERROR"

        # Apply color
        color = self.COLOR_MAP.get(record.levelno, Colors.ENDC)
        record.levelname = f"{color}{record.levelname}{Colors.ENDC}"

        # Simplified format - just time, level, and message
        self._style._fmt = (
            f"{Colors.GRAY}%(asctime)s{Colors.ENDC} %(levelname)s %(message)s"
        )
        self.datefmt = "%H:%M:%S"

        return super().format(record)


# Configure logging for CLI
def setup_logging():
    """Configure enhanced logging for CLI interface"""
    logger = logging.getLogger(__name__)
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    # Console handler with colored formatting
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.DEBUG)  # Show DEBUG and above to users

    colored_formatter = ColoredFormatter()
    console_handler.setFormatter(colored_formatter)
    logger.addHandler(console_handler)

    return logger


logger = setup_logging()

import dotenv

dotenv.load_dotenv()
logger.debug("✨ Environment loaded")

from lmnr import Laminar

Laminar.initialize(
    base_url="http://localhost",
    http_port=8000,
    grpc_port=8001,
)


# --- Setup Runner and Session ---
async def setup_session_and_runner():
    """Setup database session and agent runner"""
    logger.debug("Setting up agent infrastructure...")

    try:
        db_url = "sqlite:///./my_agent_data.db"
        logger.debug(f"📂 Database: {db_url}")

        session_service = DatabaseSessionService(db_url=db_url)
        session_id = str(uuid.uuid4())

        session = await session_service.create_session(
            app_name="dude", user_id="john", session_id=session_id, state={}
        )
        logger.info(f"📱 Session created: {session_id[:8]}...")

        orchestrator = Orchestrator(
            planner_agent=planner,
            coder_agent=coder,
            tester_agent=coder,
            name="orchestrator",
        )
        logger.debug("🎯 Orchestrator ready")

        runner = Runner(
            agent=orchestrator,
            app_name="dude",
            session_service=session_service,
        )
        logger.debug("🏃 Runner ready")

        return session_service, session, runner

    except Exception as e:
        logger.error(f"Setup failed: {str(e)}", exc_info=True)
        raise


# --- Function to Interact with the Agent ---
async def call_agent_async(user_input_topic: str):
    """Send a topic to the agent and run the workflow"""
    logger.info(f"Processing request...")
    logger.debug(f"Topic: {user_input_topic[:100]}...")

    try:
        session_service, current_session, runner = await setup_session_and_runner()
        current_session.state["topic"] = user_input_topic
        logger.debug("💾 Topic saved to session")

        content = types.Content(
            role="user",
            parts=[types.Part(text=f"{user_input_topic}")],
        )

        logger.info("🧠 Agent thinking...")
        print()

        events = runner.run_async(
            user_id=current_session.user_id,
            session_id=current_session.id,
            new_message=content,
        )

        final_response = "No response received"
        event_count = 0

        async for event in events:
            event_count += 1
            logger.debug(f"📨 Event from: {event.author}")

            if event.is_final_response() and event.content and event.content.parts:
                response_text = event.content.parts[0].text
                logger.info(f"✉️  Response from {event.author}")
                final_response = response_text

        logger.info(f"✨ Completed: {event_count} steps")

        print()
        print_user_message("🤖 Agent Response:")
        print(Colors.CYAN + "─" * 60 + Colors.ENDC)
        print(final_response)
        print(Colors.CYAN + "─" * 60 + Colors.ENDC)
        print()

    except Exception as e:
        logger.error(f"Agent error: {str(e)}", exc_info=True)
        raise


def main():
    """Main CLI entry point"""
    print_banner()

    logger.debug(f"Python {sys.version.split()[0]}")
    logger.debug(f"Started at {datetime.now().strftime('%H:%M:%S')}")

    # Validate arguments
    if len(sys.argv) < 2:
        print_error("No topic provided! Usage: dude <your-topic>")
        print(f"\n{Colors.YELLOW}Example:{Colors.ENDC}")
        print(f'  dude "Create a Python function to parse JSON"')
        sys.exit(1)

    argument = sys.argv[1]
    logger.info(f"Request: {argument[:60]}...")

    try:
        asyncio.run(call_agent_async(str(argument)))
        print_success("Mission accomplished! 🎉")
    except KeyboardInterrupt:
        print_error("Cancelled by user (Ctrl+C)")
        sys.exit(130)
    except Exception as e:
        print_error(f"Something went wrong: {str(e)}")
        sys.exit(1)
    finally:
        logger.debug("Shutting down...")
        print(
            f"\n{Colors.MAGENTA}{ICONS['SHUTDOWN']} Thanks for using Dude!{Colors.ENDC}"
        )


if __name__ == "__main__":
    main()
