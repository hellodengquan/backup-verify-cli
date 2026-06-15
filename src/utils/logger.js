import chalk from 'chalk';

const logger = {
  info(msg) {
    console.log(chalk.blue('[INFO]'), msg);
  },
  success(msg) {
    console.log(chalk.green('[SUCCESS]'), msg);
  },
  warn(msg) {
    console.log(chalk.yellow('[WARN]'), msg);
  },
  error(msg) {
    console.error(chalk.red('[ERROR]'), msg);
  },
  debug(msg, verbose = false) {
    if (verbose) {
      console.log(chalk.gray('[DEBUG]'), msg);
    }
  },
  section(title) {
    console.log('');
    console.log(chalk.cyan.bold(`=== ${title} ===`));
  },
  listItem(msg) {
    console.log(chalk.gray('  •'), msg);
  }
};

export default logger;
