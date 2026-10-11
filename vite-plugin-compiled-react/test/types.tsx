import type {} from '../src/index.js';
import { css } from '@compiled/react';

export const elements = (
  <div css={{ color: 'red' }}>
    <svg css={[css({ color: 'red' }), { fill: 'blue' }]} />
  </div>
);
