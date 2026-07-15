"""APP_DISPLAY_NAME - a Streamlit app for the Nebari Apps Pack.

Local dev: pixi run dev
The platform injects STREAMLIT_SERVER_PORT/ADDRESS in the cluster; no flags needed.
"""

import pandas as pd
import streamlit as st

st.set_page_config(page_title="APP_DISPLAY_NAME", layout="wide")
st.title("APP_DISPLAY_NAME")

data = pd.DataFrame({"x": range(1, 11), "y": [n**2 for n in range(1, 11)]})

st.line_chart(data, x="x", y="y")
st.caption("Replace this starter with your app.")
