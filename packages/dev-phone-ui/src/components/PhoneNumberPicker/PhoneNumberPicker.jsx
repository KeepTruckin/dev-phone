import { useState, useEffect } from "react";

import { Anchor, Box, Button, Heading, Label, Option, Select, Stack, Alert, Text, SkeletonLoader, Paragraph, Card } from "@twilio-paste/core";
import WelcomeDialog from "./WelcomeDialog";
import {
  badgeLabelFor,
  isDisabledForCurrentUser,
  ownershipSortRank,
  OWNERSHIP_STATES,
} from "../../utils/ownership";

const hasExistingSmsConfig = (pn) => {
  return pn.smsUrl && pn.smsUrl !== "https://demo.twilio.com/welcome/sms/reply";
};

const hasExistingVoiceConfig = (pn) => {
  return (
    pn.voiceUrl && pn.voiceUrl !== "https://demo.twilio.com/welcome/voice/"
  );
};

const hasExistingConfig = (pn) => {
  return hasExistingSmsConfig(pn) || hasExistingVoiceConfig(pn);
};

const getSelectLabelForPn = (pn) => {
  const badge = badgeLabelFor(pn.ownership);
  const badgeText = badge ? ` — ${badge}` : "";
  return `${pn.phoneNumber} [${pn.friendlyName}]${badgeText}`;
};

const getPnDetailsByNumber = (pn, allPns) => {
  return allPns.filter((thisPn) => thisPn.phoneNumber === pn)[0];
};

const sortByOwnershipThenAlphabetically = (pn1, pn2) => {
  const rankDelta = ownershipSortRank(pn1.ownership) - ownershipSortRank(pn2.ownership);
  if (rankDelta !== 0) return rankDelta;
  return pn1.phoneNumber.localeCompare(pn2.phoneNumber);
};

const firstSelectableNumber = (pns) => {
  return pns.find((pn) => !isDisabledForCurrentUser(pn.ownership)) || pns[0];
};

const numPicker = async (currentNum, selectNum, getAvailableNums) => {
  if (!currentNum) {
    try {
      const response = await fetch('/phone-numbers')
      const data = await response.json()
      data["phone-numbers"].sort(sortByOwnershipThenAlphabetically)
      getAvailableNums(data["phone-numbers"]);
      if (data["phone-numbers"].length !== 0) {
        const first = firstSelectableNumber(data["phone-numbers"]);
        if (first) {
          selectNum(getPnDetailsByNumber(first.phoneNumber, data["phone-numbers"]));
        }
      }
    } catch (error) {
      console.error(error)
    }
  }
}


function PhoneNumberPickerContainer({ children }) {
  return <Box
    maxWidth={"75%"}
    margin={"auto"}
    marginY={"space120"}
    padding={"space120"}
    backgroundColor={"colorBackgroundBody"}
    boxShadow={"shadow"}
    borderRadius={"borderRadius20"}
  >
    {children}
  </Box>
}


function PhoneNumberPicker({ configureNumberInUse, phoneNumbers }) {
  const [twilioPns, setTwilioPns] = useState(null);
  const [selectedPn, setSelectedPn] = useState(null);

  useEffect(() => {
    numPicker(selectedPn, setSelectedPn, setTwilioPns);
  }, [selectedPn]);

  if (twilioPns === null) {
    return (<SkeletonLoader height={"size50"} />)
  } else if (twilioPns.length === 0) {
    return (
      <PhoneNumberPickerContainer>
        <WelcomeDialog />
        <Stack orientation={"vertical"}>
          <Box width="200px" as="img" src="https://paste.twilio.design/images/patterns/empty-no-results-found.png" alt="" />
          <Heading as="h2" variant="heading20">Could not find any phone numbers.</Heading>
          <Paragraph>In order to use the Dev Phone you'll need to have a Twilio Phone Number. Once you purchased a phone number you can refresh this page to get started.</Paragraph>
          <Button
            as="a"
            href="https://support.twilio.com/hc/en-us/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console"
            target="_blank"
          >Purchase a phone number to get started.</Button>
        </Stack>
      </PhoneNumberPickerContainer>
    )
  } else {
    return (
      <PhoneNumberPickerContainer>
        <WelcomeDialog />
        <Stack orientation="vertical">
          <Heading as="h2" variant="heading20">Select a phone number</Heading>
          <Paragraph>
            Pick one of the phone numbers from your Twilio account to configure your Dev Phone. This phone number will be the one to send messages and make calls.
            Any calls and text messages sent to this number will show up in the Dev Phone.
          </Paragraph>
          <Label htmlFor="devPhonePn" required>
            Phone number
          </Label>
          <Select
            id="devPhonePn"
            onChange={(e) =>
              setSelectedPn(getPnDetailsByNumber(e.target.value, twilioPns))
            }
          >
            {twilioPns.map((pn) => {
              const disabled = isDisabledForCurrentUser(pn.ownership);
              return (
                <Option
                  key={pn.phoneNumber}
                  value={pn.phoneNumber}
                  disabled={disabled}
                >
                  {getSelectLabelForPn(pn)}
                </Option>
              );
            })}
          </Select>
        </Stack>

        {selectedPn ? (
          <Stack orientation="vertical" spacing="space60">
            {isDisabledForCurrentUser(selectedPn.ownership) ? (
              <Alert variant="error">
                This number is in use by {selectedPn.ownership.ownerDisplay || selectedPn.ownership.ownerSlug}'s dev-phone. Pick a different number.
              </Alert>
            ) : hasExistingConfig(selectedPn) ? (
              <Stack orientation="vertical" spacing="space30">
                <Alert variant="warning">
                  {selectedPn.ownership?.state === OWNERSHIP_STATES.TAKEN && selectedPn.ownership?.isYou
                    ? "This number was previously configured by your dev-phone. Selecting it will refresh the webhooks."
                    : "This phone number has existing config which will be overwritten"}
                </Alert>
                {hasExistingSmsConfig(selectedPn) ? (
                  <Text >Configured SMS URL: <em>{selectedPn.smsUrl}</em></Text>
                ) : (
                  ""
                )}
                {hasExistingVoiceConfig(selectedPn) ? (
                  <Text>Configured Voice URL: <em>{selectedPn.voiceUrl}</em></Text>
                ) : (
                  ""
                )}
              </Stack>
            ) : (
              ""
            )}

            <Button
              variant="primary"
              disabled={isDisabledForCurrentUser(selectedPn.ownership)}
              onClick={(e) => configureNumberInUse(selectedPn)}
            >
              Use this phone number
            </Button>
          </Stack>
        ) : (
          ""
        )}
      </PhoneNumberPickerContainer>
    );
  }
}

export default PhoneNumberPicker;
