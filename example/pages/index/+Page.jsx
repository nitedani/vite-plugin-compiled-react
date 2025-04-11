export default Page
import {styles} from './style.ts'
import React from 'react'
import { Counter } from './Counter'

function Page() {
  return (
    <>
      <h1 css={styles.counter}>Welcome</h1>
      This page is:
      <ul>
        <li>Rendered to HTML.</li>
        <li>
          Interactive. <Counter />
        </li>
      </ul>
    </>
  )
}
