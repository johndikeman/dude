import logging
import uuid

from google.genai import types
from google.adk.runners import Runner
from google.adk.sessions import DatabaseSessionService

from dude.agents.orchestrator import Orchestrator
from dude.agents import planner, coder

logger = logging.getLogger(__name__)

import dotenv

dotenv.load_dotenv()

import openlit

openlit.init()


# --- Setup Runner and Session ---
async def setup_session_and_runner():
    db_url = "sqlite:///./my_agent_data.db"
    session_service = DatabaseSessionService(db_url=db_url)

    session = await session_service.create_session(
        app_name="dude", user_id="john", session_id=str(uuid.uuid4()), state={}
    )

    orchestrator = Orchestrator(
        planner_agent=planner,
        coder_agent=coder,
        tester_agent=coder,
        name="orchestrator",
    )
    runner = Runner(
        agent=orchestrator,  # Pass the custom orchestrator agent
        app_name="dude",
        session_service=session_service,
    )
    return session_service, session, runner


# --- Function to Interact with the Agent ---
async def call_agent_async(user_input_topic: str):
    """
    Sends a new topic to the agent (overwriting the initial one if needed)
    and runs the workflow.
    """

    session_service, current_session, runner = await setup_session_and_runner()

    current_session.state["topic"] = user_input_topic
    logger.info(f"Updated session state topic to: {user_input_topic}")

    content = types.Content(
        role="user",
        parts=[
            types.Part(
                text=f"Add some basic nice looking logging in the UI in main.py."
            )
        ],
    )

    events = runner.run_async(
        user_id=current_session.user_id,
        session_id=current_session.id,
        new_message=content,
    )

    final_response = "No final response captured."
    async for event in events:
        if event.is_final_response() and event.content and event.content.parts:
            logger.info(
                f"Potential final response from [{event.author}]: {event.content.parts[0].text}"
            )
            final_response = event.content.parts[0].text

    print("\n--- Agent Interaction Result ---")
    print("Agent Final Response: ", final_response)
