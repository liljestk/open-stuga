function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function parseArguments(argv) {
  const options = {
    builder: "stugu-release-local",
    help: false,
    keepDraft: false,
    prerelease: false,
    publish: false,
    providedArguments: [],
    reuseContainers: false,
    uploadFactory: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--")) options.providedArguments.push(argument.split("=", 1)[0]);
    switch (argument) {
      case "--builder":
        options.builder = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--image-prefix":
        options.imagePrefix = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-generation":
        options.hostGeneration = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--full-ci-receipt":
        options.fullCiReceipt = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-qualification":
        options.hostQualification = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-rauc-ca":
        options.hostRaucCa = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-tuf-root":
        options.hostTufRoot = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--host-update-base-url":
        options.hostUpdateBaseUrl = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--notes-file":
        options.notesFile = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--keep-draft":
        options.keepDraft = true;
        break;
      case "--prerelease":
        options.prerelease = true;
        break;
      case "--publish":
        options.publish = true;
        break;
      case "--repository":
        options.repository = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--reuse-containers":
        options.reuseContainers = true;
        break;
      case "--ssh-public-key":
        options.sshPublicKey = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--tag":
        options.tag = optionValue(argv, index, argument);
        index += 1;
        break;
      case "--upload-factory":
        options.uploadFactory = true;
        break;
      case "--verification-receipt":
        options.verificationReceipt = optionValue(argv, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}
