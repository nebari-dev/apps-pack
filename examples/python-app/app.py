"""A small but real Streamlit app, launched on Nebari by a pixi task."""

import numpy as np
import pandas as pd
import streamlit as st

st.set_page_config(page_title="Pixi Streamlit Demo", page_icon="🚀")

st.title("Pixi Streamlit Demo")
st.write(
    "This app was deployed with the Nebari Apps Pack: a zip (or git subdir) "
    "containing a `pixi.toml`, launched by the `start` pixi task."
)

st.header("Random walk")
points = st.slider("Points", min_value=50, max_value=1000, value=250, step=50)
seed = st.number_input("Seed", min_value=0, max_value=9999, value=42)

rng = np.random.default_rng(int(seed))
walk = pd.DataFrame(
    rng.standard_normal((int(points), 3)).cumsum(axis=0),
    columns=["alpha", "beta", "gamma"],
)
st.line_chart(walk)

st.header("Summary")
st.dataframe(walk.describe())

with st.expander("How this runs"):
    st.markdown(
        "- `runtime.pixiTask: start` on the `App` resource selects the pixi runtime\n"
        "- the operator runs `pixi install --locked` (a `pixi.lock` ships with the app) "
        "then `pixi run start`\n"
        "- Streamlit serves on `0.0.0.0:8080`; routing, TLS, and SSO come from the gateway"
    )
